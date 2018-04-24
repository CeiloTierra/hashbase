const sse = require('express-server-sent-events')
const {DAT_KEY_REGEX, COHORT_STATE_ACTIVE, NotFoundError, UnauthorizedError, ForbiddenError} = require('../const')
const {wait} = require('../helpers')
const lock = require('../lock')

// exported api
// =

module.exports = class ArchivesAPI {
  constructor (cloud) {
    this.config = cloud.config
    this.usersDB = cloud.usersDB
    this.archivesDB = cloud.archivesDB
    this.activityDB = cloud.activityDB
    this.archiver = cloud.archiver
  }

  async add (req, res) {
    // validate session
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('user')) throw new ForbiddenError()

    // validate & sanitize input
    req.checkBody('key').optional().isDatHash()
    req.checkBody('url').optional().isDatHashOrURL()
    req.checkBody('name').optional()
      .isDatName().withMessage('Names must only contain characters, numbers, and dashes.')
      .isLength({ min: 1, max: 63 }).withMessage('Names must be 1-63 characters long.')
    ;(await req.getValidationResult()).throw()
    if (req.body.url) req.sanitizeBody('url').toDatDomain()
    var { key, url, name } = req.body

    // only allow one or the other
    if ((!key && !url) || (key && url)) {
      return res.status(422).json({
        message: 'Must provide a key or url',
        invalidInputs: true
      })
    }
    if (url) {
      key = DAT_KEY_REGEX.exec(url)[1]
    }

    var release = await Promise.all([lock('users'), lock('archives')])
    try {
      // fetch user's record
      var userRecord = await this.usersDB.getByID(res.locals.session.id)

      // check that the user has the available quota
      if (this.config.getUserDiskQuotaPct(userRecord) >= 1) {
        return res.status(422).json({
          message: 'You have exceeded your disk usage',
          outOfSpace: true
        })
      }

      if (name && userRecord.archives.find(a => a.name === name)) {
        return res.status(422).json({
          message: 'There were errors in your submission',
          details: {
            name: {
              msg: `You already have an archive named ${name}. Please select a new name.`
            }
          }
        })
      }

      // update the records
      // TEMPORARY we have to do addHostingUser first, and cancel if that fails
      // await Promise.all([
      //   this.usersDB.addArchive(userRecord.id, key, name),
      //   this.archivesDB.addHostingUser(key, userRecord.id)
      // ])
      try {
        await this.archivesDB.addHostingUser(key, userRecord.id)
      } catch (e) {
        return res.status(422).json({
          message: 'This archive is already being hosted by someone else'
        })
      }
      await this.usersDB.addArchive(userRecord.id, key, name)
    } finally {
      release[0]()
      release[1]()
    }

    // record the event
    /* dont await */ req.logAnalytics('add-archive', {user: userRecord.id, key, name})
    /* dont await */ this.usersDB.updateCohort(userRecord, COHORT_STATE_ACTIVE)
    /* dont await */ this.activityDB.writeGlobalEvent({
      userid: userRecord.id,
      username: userRecord.username,
      action: 'add-archive',
      params: {key, name}
    })

    // add to the swarm
    this.archiver.loadArchive(key).then(() => {
      this.archiver._swarmArchive(key, {upload: true, download: true})
    })

    // respond
    res.status(200).end()
  }

  async remove (req, res) {
    // validate session
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('user')) throw new ForbiddenError()

    // validate & sanitize input
    req.checkBody('key').optional().isDatHash()
    req.checkBody('url').optional().isDatHashOrURL()
    ;(await req.getValidationResult()).throw()
    if (req.body.url) req.sanitizeBody('url').toDatDomain()
    var { key, url } = req.body

    // only allow one or the other
    if ((!key && !url) || (key && url)) {
      return res.status(422).json({
        message: 'Must provide a key or url',
        invalidInputs: true
      })
    }
    if (url) {
      key = DAT_KEY_REGEX.exec(url)[1]
    }

    var release = await Promise.all([lock('users'), lock('archives')])
    try {
      // fetch the user
      var userRecord = await this.usersDB.getByID(res.locals.session.id)

      // find the archive name
      var archiveRecord = await this.archivesDB.getExtraByKey(key)
      var name = archiveRecord.name

      // update the records
      await Promise.all([
        this.usersDB.removeArchive(res.locals.session.id, key),
        this.archivesDB.removeHostingUser(key, res.locals.session.id)
      ])
    } finally {
      release[0]()
      release[1]()
    }

    // record the event
    /* dont await */ req.logAnalytics('remove-archive', {user: userRecord.id, key, name})
    /* dont await */ this.activityDB.writeGlobalEvent({
      userid: userRecord.id,
      username: userRecord.username,
      action: 'del-archive',
      params: {key, name}
    })

    // remove from the swarm
    var archive = await this.archivesDB.getByKey(key)
    if (!archive.hostingUsers.length) {
      /* dont await */ this.archiver.closeArchive(key)
    }

    // respond
    res.status(200).end()
  }

  async list (req, res) {
    // we're getting user-specific information, so only handle this call if logged in
    if (!res.locals.sessionUser) {
      return res.status(200).json({items: []})
    }

    var items = await Promise.all(
      res.locals.sessionUser.archives.map(a => (
        this._getArchiveInfo(res.locals.sessionUser, a)
      ))
    )
    return res.status(200).json({items})
  }

  async get (req, res) {
    if (req.query.view === 'status') {
      return this.archiveStatus(req, res)
    }

    // we're getting user-specific information, so only handle this call if logged in
    if (!res.locals.sessionUser) throw new NotFoundError()

    // lookup archive
    var archive = res.locals.sessionUser.archives.find(a => a.key === req.params.key)
    if (!archive) throw new NotFoundError()

    // give info about the archive
    var info = await this._getArchiveInfo(res.locals.sessionUser, archive)
    return res.json(info)
  }

  async update (req, res) {
    // validate session
    if (!res.locals.session) throw new UnauthorizedError()
    if (!res.locals.session.scopes.includes('user')) throw new ForbiddenError()

    // validate & sanitize input
    req.checkBody('name').optional()
      .isDatName().withMessage('Names must only contain characters, numbers, and dashes.')
      .isLength({ min: 1, max: 63 }).withMessage('Names must be 1-63 characters long.')
    ;(await req.getValidationResult()).throw()
    var key = req.params.key
    var { name } = req.body

    var release = await Promise.all([lock('users'), lock('archives')])
    try {
      // fetch user's record
      var userRecord = await this.usersDB.getByID(res.locals.session.id)

      // find the archive
      var archiveRecord = userRecord.archives.find(a => a.key === key)
      if (!archiveRecord) {
        throw new NotFoundError()
      }

      // make sure the name is available
      if (name && userRecord.archives.find(a => a.key !== key && a.name === name)) {
        return res.status(422).json({
          message: 'There were errors in your submission',
          details: {
            name: {
              msg: `You already have an archive named ${name}. Please select a new name.`
            }
          }
        })
      }

      // update the records
      if (typeof name !== 'undefined') {
        archiveRecord.name = name
      }
      // update records
      await this.usersDB.put(userRecord)
    } finally {
      release[0]()
      release[1]()
    }

    // record the event
    /* dont await */ this.activityDB.writeGlobalEvent({
      userid: userRecord.id,
      username: userRecord.username,
      action: 'update-archive',
      params: {key, name}
    })

    // respond
    res.status(200).end()
  }

  async getByName (req, res) {
    // validate & sanitize input
    req.checkParams('username').isAlphanumeric().isLength({ min: 3, max: 16 })
    req.checkParams('archivename').isDatName().isLength({ min: 1, max: 64 })
    ;(await req.getValidationResult()).throw()
    var { username, archivename } = req.params

    // lookup user
    var userRecord = await this.usersDB.getByUsername(username)
    if (!userRecord) throw new NotFoundError()

    // lookup archive
    const findFn = (DAT_KEY_REGEX.test(archivename))
      ? a => a.key === archivename
      : a => a.name === archivename
    var archive = userRecord.archives.find(findFn)
    if (!archive) throw new NotFoundError()

    // lookup manifest
    var manifest = await this.archiver.getManifest(archive.key)

    // respond
    res.status(200).json({
      user: username,
      key: archive.key,
      name: archive.name,
      title: manifest ? manifest.title : '',
      description: manifest ? manifest.description : ''
    })
  }

  async archiveStatus (req, res) {
    var type = req.accepts(['json', 'text/event-stream'])
    if (type === 'text/event-stream') {
      sse(req, res, () => this._getArchiveProgressEventStream(req, res))
    } else {
      let progress = await this._getArchiveProgress(req.params.key)
      res.status(200).json({ progress })
    }
  }

  async _getArchive (key) {
    var archive = this.archiver.getArchive(key)
    if (!archive) {
      if (!this.archiver.isLoadingArchive(key)) {
        throw new NotFoundError()
      }
      archive = await this.archiver.loadArchive(key)
    }
    return archive
  }

  async _getArchiveInfo (userRecord, archive) {
    // figure out additional urls
    var additionalUrls = []
    if (archive.name) {
      var niceUrl = archive.name === userRecord.username
        ? `${userRecord.username}.${this.config.hostname}`
        : `${archive.name}-${userRecord.username}.${this.config.hostname}`
      additionalUrls = [`dat://${niceUrl}`, `https://${niceUrl}`]
    }

    // load manifest data
    var title = ''
    var description = ''
    var manifest = await this.archiver.getManifest(archive.key)
    if (manifest) {
      title = manifest.title || 'Untitled'
      description = manifest.description || ''
    }

    return {
      url: `dat://${archive.key}`,
      name: archive.name,
      title,
      description,
      additionalUrls
    }
  }

  _getArchiveProgressEventStream (req, res) {
    let to
    let done = false
    let self = this
    async function send () {
      try {
        var progress = await self._getArchiveProgress(req.params.key)
      } catch (e) {
        return // not found
      }
      if (done) return
      res.sse('data: ' + progress + '\n\n')
      to = setTimeout(send, 1e3)
    }
    res.once('close', () => {
      done = true
      clearTimeout(to)
    })
    send()
  }

  async _getArchiveProgress (key) {
    // fetch the archive
    var archive = await Promise.race([
      this._getArchive(key),
      wait(5e3, false)
    ])
    if (!archive) return 0
    var {metadata, content} = archive

    // some data missing, report progress at zero
    if (!metadata || !metadata.length || !content || !content.length) {
      return 0
    }

    // calculate & respond
    var need = metadata.length + content.length
    var remaining = blocksRemaining(metadata) + blocksRemaining(content)
    return (need - remaining) / need
  }
}

function blocksRemaining (feed) {
  var remaining = 0
  for (var i = 0; i < feed.length; i++) {
    if (!feed.has(i)) remaining++
  }
  return remaining
}

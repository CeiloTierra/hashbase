/* global $ navigator localStorage */

// ua js
$(function () {
  var beakerPrompts = $('.beaker-prompt')
  var usingBeaker = navigator && navigator.userAgent.includes('BeakerBrowser')

  if (!usingBeaker && localStorage.hasDismissedBeakerPrompt !== '1') {
    Array.from(beakerPrompts).forEach(function (el) {
      el.classList.remove('hidden')
      $(el).click(function (e) {
        el.style.display = 'none'
        localStorage.hasDismissedBeakerPrompt = 1
      })
    })
  }
})

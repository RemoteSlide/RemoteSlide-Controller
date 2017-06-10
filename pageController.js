var socket = io("https://remote-sli.de");
socket.on("init", function (data) {
    if (data.state == "start") {
        console.info("Initializing session #" + remote_slide.session);
        setTimeout(function () {
            socket.emit("init", {iAm: "host", session: remote_slide.session, injector: remote_slide.injector});
        }, 500);
        status("orange", "question", "");
    } else if (data.state == "success") {
        console.info("Session initialized");
        status("green", "check", "", 5000);
        session.info = data.info;
        session.type = data.youAre;
        session.clientId = data.yourId;
        if (session.info.remotes.length <= 0) {
            overlayMessage.show("Waiting for a remote to connect....");
        }
    } else if (data.state == "not_found") {
        console.warn("Session not found");
        overlayMessage.show("Session not found");
        setTimeout(function () {
            window.open("https://remote-sli.de", "_blank")
        }, 1000);
    }


    try {
        chrome.runtime.sendMessage({action: "socketEvent", event: 'init', data: data});
        chrome.runtime.sendMessage({action: "sessionUpdate", session: session});
        chrome.runtime.sendMessage({action: "controlUpdate", active: true, site: (detectedSlideSite ? detectedSlideSite.name : undefined)});
    } catch (ignored) {
    }
});
socket.on("info", function (data) {
    console.log(data);
    if (data.type == 'client_connected') {
        session.info = data.info;
        if (data.clientType == 'remote') {
            overlayMessage.hide();

            $("#rs-laser-dots").append("<div class='rs-laser-dot' id='rs-laser-dot-" + data.who + "' style='display:none'><i class='fa fa-circle' aria-hidden='true'></i></div>")
        }
    }
    if (data.type == 'client_disconnected') {
        session.info = data.info;
        if (data.clientType == 'remote') {
            if (session.info.remotes.length <= 0) {
                overlayMessage.show("Waiting for a remote to connect....");
            }
        }
    }

    try {
        chrome.runtime.sendMessage({action: "socketEvent", event: 'info', data: data});
        chrome.runtime.sendMessage({action: "sessionUpdate", session: session});
    } catch (ignored) {
    }
});
socket.on("connectionInfo", function (data) {
    session.info = data.info;
})

try {
    chrome.extension.onMessage.addListener(function (msg, sender, sendResponse) {
        console.log(msg)
        if (msg.action == 'stateRequest') {
            chrome.runtime.sendMessage({action: "controlUpdate", active: true, site: (detectedSlideSite ? detectedSlideSite.name : undefined)});
        }
    });
} catch (ignored) {
}
window.onunload = function () {
    console.info("UNLOAD")
    chrome.runtime.sendMessage({action: "controlUpdate", active: false});
}
socket.on('disconnect', function () {
    console.log("DISCONNECT")
    chrome.runtime.sendMessage({action: "controlUpdate", active: false});
});


var session = {
    session: remote_slide.session,
    info: {
        observer: false,
        host: false,
        remotes: []
    }
};

var slideSites = {
    googleSlides: {
        name: "Google Slides",
        urlPattern: /https:\/\/docs\.google\.com\/presentation\/.+/g,
        getSlideSizeAndIndex: function () {
            var element = $(".goog-flat-menu-button-caption,[role=option]");
            var size = element.attr("aria-setsize");
            var index = element.attr("aria-posinset");

            if (!slideIndexListenerAdded) {
                element.attrchange({
                    trackValues: true,
                    callback: function (event) {
                        console.log(event.attributeName + ": " + event.oldValue + " -> " + event.newValue)
                        if (event.attributeName == "aria-posinset") {
                            sendSlideInfo();
                            setTimeout(sendScreenshot, 1000);
                        }
                    }
                })
                slideIndexListenerAdded = true;
            }

            return [parseInt(index), parseInt(size)];
        }
    },
    slidesCom: {
        name: "slides.com",
        urlPattern: /https?:\/\/slides\.com\/.+/g,
        getSlideSizeAndIndex: function () {
            var slideElements = $(".section,[data-id]");
            var size = slideElements.length;
            var index = 0;
            slideElements.each(function (i) {
                if ($(this).hasClass("present"))
                    index = i;
            })

            if (!slideIndexListenerAdded) {
                slideElements.each(function () {
                    $(this).attrchange({
                        trackValues: true,
                        callback: function (event) {
                            if (event.attributeName == "class") {
                                if (event.newValue == "present") {
                                    onlyRunOnce(function () {
                                        console.log(event.attributeName + ": " + event.oldValue + " -> " + event.newValue)

                                        sendSlideInfo();
                                        setTimeout(sendScreenshot, 750);
                                    })
                                }
                            }
                        }
                    })
                })
                slideIndexListenerAdded = true;
            }

            return [parseInt(index) + 1, parseInt(size)];
        }
    },
    prezi: {//TODO: Prezi support
        name: "Prezi",
        urlPattern: /https?:\/\/prezi\.com\/p\/.+/g,
        getSlideSizeAndIndex: function () {
            var varibleBridge = $("#rs-prezi-var-bridge");
            console.log(varibleBridge);
            var data = varibleBridge.text();
            data = JSON.parse(data);

            var size = data.size;
            var index = data.index;

            if (!slideIndexListenerAdded) {
                varibleBridge.on("change", function () {
                    sendSlideInfo();
                    setTimeout(sendScreenshot, 1000);
                });
                slideIndexListenerAdded = true;
            }

            return [index + 1, size]
        }
    }
};
var slideIndexListenerAdded = false;
var detectedSlideSite = undefined;
$.each(slideSites, function (i, site) {
    if (site.urlPattern.test(window.location.href)) {
        detectedSlideSite = site;
    }
});
if (detectedSlideSite) {
    console.info("[SlideDetector] Detected '" + detectedSlideSite.name + "'");
} else {
    console.log("[SlideDetector] No slide website detected for " + window.location.href);
}
var sendSlideInfo = function () {
    var slideInfo = {
        page: {
            index: 0,
            size: 0
        },
        site: undefined
    };
    if (detectedSlideSite) {
        slideInfo.site = detectedSlideSite.name;
        var indexAndSize = detectedSlideSite.getSlideSizeAndIndex();
        slideInfo.page.index = indexAndSize[0];
        slideInfo.page.size = indexAndSize[1];
    }
    socket.emit("_forward", {event: "slideInfo", data: {info: slideInfo}});
};
var sendScreenshot = function () {
    try {
        chrome.runtime.sendMessage({action: "takeScreenshot"}, function (image) {
            console.log(image)
            socket.emit("_forward", {event: "screenshot", data: {image: image.image}});
        });
    } catch (ignored) {
    }
}
setTimeout(function () {
    sendSlideInfo();
    sendScreenshot();
}, 1000);


// var settings = {
//     navigationType: 'button',
//     vibration: true,
//     laserCalibration: {
//         center: {
//             yaw: 0,
//             pitch: 0
//         },
//         range: {
//             yaw: 90,
//             pitch: 90
//         }
//     },
//     laserStyle: {
//         color: "red",
//         'font-size': 15
//     }
// };
var settings = {};
socket.on("settings", function (msg) {
    settings[msg.from] = msg.settings;

    laserPointer.applyStyle(msg.from, msg.settings.laserStyle);
});
window.__remoteSlideSettings = settings;

socket.on("control", function (msg) {
    var keyCode = msg.keyCode;
    var ctrlKey = msg.keys && msg.keys.ctrl;
    var shiftKey = msg.keys && msg.keys.shift;
    var altKey = msg.keys && msg.keys.alt;

    // alert("Control: " + keyCode);
    console.log("Remote Key Event: " + (ctrlKey ? "[ctrl] + " : shiftKey ? "[shift] + " : altKey ? "[alt] + " : "") + keyCode);
    simulateKeyEvent(keyCode, ctrlKey, shiftKey, altKey);

    setTimeout(function () {
        sendSlideInfo()
    }, 500)
});
//// http://stackoverflow.com/questions/26816306/is-there-a-way-to-simulate-pressing-multiple-keys-on-mouse-click-with-javascript
function simulateKeyEvent(keyCode, ctrlKey, shiftKey, altKey) {
    // Prepare function for injection into page
    function injected() {
        // Adjust as needed; some events are only processed at certain elements
        var element = document.body;
        var keyCode = ___keyCode;

        console.log(element)

        function keyEvent(el, ev) {
            var eventObj = document.createEvent("Events");
            eventObj.initEvent(ev, true, true);

            // Edit this to fit
            eventObj.keyCode = keyCode;
            eventObj.which = keyCode;
            //TODO: fix this
            // eventObj.ctrlKey = ctrlKey;
            // eventObj.shiftKey = shiftKey;
            // eventObj.altKey = altKey;

            var res = el.dispatchEvent(eventObj);
            console.log("KeyResult (" + ev + "): " + res)
            return res;
        }

        // Trigger all 3 just in case
        var r = true;
        r &= keyEvent(element, "keydown");
        r &= keyEvent(element, "keypress");
        r &= keyEvent(element, "keyup");
        console.log("Complete KeyResult: " + r)
        if (r == true) {
            console.warn("Simulating Key Event failed (probably)")
        }
    }

    // Inject the script
    console.log(document.body)
    console.log($("body"))
    var script = document.createElement('script');
    script.textContent = "(" + injected.toString().replace("___keyCode", keyCode) + ")();";
    // console.log(script.textContent)
    (document.head || document.documentElement).appendChild(script);
    script.parentNode.removeChild(script);
}

var overlayMessage = {
    show: function (msg) {
        $(".overlay-message-content").text(msg);
        $(".laser-calibration-backdrop").fadeIn();
    },
    hide: function () {
        $(".laser-calibration-backdrop").fadeOut();
        $(".overlay-message-content").empty()
    }
};

var laserPointer = {
    applyStyle: function (client, styles) {
        var element = $("#rs-laser-dot-" + client);
        $.each(styles, function (key, value) {
            element.css(key, value);
        })
        var iconElement = element.children().first();
        iconElement.removeClass().addClass("fa").addClass("fa-" + (styles._icon || "circle"));
    },
    currentPoint: [],
    lastMessage: 0,
    visible: {},
    hideTimers: {}
};
socket.on("deviceOrientation", function (msg) {
    laserPointer.lastMessage = new Date().valueOf();

    var screenWidth = $(window).width() - 10;
    var screenHeight = $(window).height() - 10;

    var vector = msg.v;

    var cx = screenWidth * vector[0] / settings[msg.from].laserCalibration.range.yaw;//90
    var cy = screenHeight * vector[1] / settings[msg.from].laserCalibration.range.pitch;//90

    cx = screenWidth - cx;

    cy = screenHeight - cy;


    cx = Math.min(screenWidth, cx);
    cy = Math.min(screenHeight, cy);
    cx = Math.max(0, cx);
    cy = Math.max(0, cy);

    console.log("Screen: " + screenWidth + "," + screenHeight)
    console.info("Cursor Position: " + cx + "," + cy);

    if (!laserPointer.visible[msg.from]) {
        console.log("fade in")
        if (!$("#rs-laser-dot-" + msg.from).length) {
            $("#rs-laser-dots").append("<div class='rs-laser-dot' id='rs-laser-dot-" + msg.from + "' style='display:none'><i class='fa fa-circle' aria-hidden='true'></i></div>")
        }
        $("#rs-laser-dot-" + msg.from).fadeIn(50);
        laserPointer.visible[msg.from] = true;
        laserPointer.applyStyle(msg.from, settings[msg.from].laserStyle);

        laserPointer.hideTimers[msg.from] = setInterval(function () {
            if (new Date().valueOf() - laserPointer.lastMessage > 200) {
                if (laserPointer.visible[msg.from]) {
                    laserPointer.visible[msg.from] = false;
                    $("#rs-laser-dot-" + msg.from).fadeOut("fast");
                    console.log("fade out")

                    clearInterval(laserPointer.hideTimers[msg.from]);
                    delete laserPointer.hideTimers[msg.from];
                }
            }
        }, 200)
    }

    $("#rs-laser-dot-" + msg.from).css("left", cx).css("top", cy).css("transform", "rotate(" + vector[2] + "deg)");
    console.log(laserPointer)
})

socket.on("calibrationDot", function (msg) {
    var action = msg.action;
    var which = msg.which;
    var $element = which == 'all' ? $(".laser-calibration-dot, .laser-calibration-backdrop") : which == 'start' ? $(".laser-calibration-backdrop") : $(".laser-calibration-dot." + which);
    if (action == 'show') {
        $element.fadeIn();
    } else if (action == 'hide') {
        $element.fadeOut();
    }
})

socket.on("err", function (msg) {
    console.warn("Slide Error #" + msg.code + ": " + msg.msg)
});

//// Latency
var startTime;
var latency;
setInterval(function () {
    startTime = Date.now();
    socket.emit('latency', {t: startTime});
}, 2000);
socket.on('latency', function () {
    latency = Date.now() - startTime;
});

function status(color, type, msg, timeout) {
    // $(".remote-slide-overlay-status").fadeOut(function() {
    //     $("#remoteSlideStatusIcons").css("color", color);
    //     $("#remoteSlideStatus-" + type).fadeIn();
    //     if (timeout) {
    //         setTimeout(function () {
    //             $("#remoteSlideStatus-" + type).fadeOut();
    //         }, timeout)
    //     }
    // });
}

var runOnceTimer;
function onlyRunOnce(f, t) {
    if (!t)t = 100;
    clearTimeout(runOnceTimer);
    runOnceTimer = setTimeout(f, t);
}
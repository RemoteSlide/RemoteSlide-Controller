const remoteSlideIo = window.remoteslideio || window.io || io;
const socket = remoteSlideIo("https://remote-sli.de");
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


    sendToExtension({action: "socketEvent", event: 'init', data: data});
    sendToExtension({action: "sessionUpdate", session: session});
    sendToExtension({action: "controlUpdate", active: true, site: (detectedSlideSite ? detectedSlideSite.name : undefined)});
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

    sendToExtension({action: "socketEvent", event: 'info', data: data});
    sendToExtension({action: "sessionUpdate", session: session});
});
socket.on("connectionInfo", function (data) {
    session.info = data.info;
})

// chrome.extension.onMessage was removed in Manifest V3
try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        console.log(msg)
        if (msg.action == 'stateRequest') {
            sendToExtension({action: "controlUpdate", active: true, site: (detectedSlideSite ? detectedSlideSite.name : undefined)});
        }
    });
} catch (ignored) {
}
// 'unload' no longer fires reliably (a page entering the back/forward cache skips
// it entirely) and it would clobber a handler the page set itself. 'pagehide' is
// the one that still gets through.
window.addEventListener("pagehide", function () {
    console.info("PAGEHIDE")
    sendToExtension({action: "controlUpdate", active: false});
});
socket.on('disconnect', function () {
    console.log("DISCONNECT")
    sendToExtension({action: "controlUpdate", active: false});
});

// The background service worker answers takeScreenshot asynchronously, so its
// listener holds the message channel open for every message it receives; each
// fire-and-forget send therefore ends in a "message port closed" lastError.
// Reading lastError inside the callback is what keeps Chrome from logging it.
// sendMessage also throws outright once the extension is reloaded and this
// content script is left orphaned in the page.
function sendToExtension(msg, callback) {
    try {
        chrome.runtime.sendMessage(msg, function (response) {
            void chrome.runtime.lastError;
            if (callback) {
                callback(response);
            }
        });
    } catch (ignored) {
        if (callback) {
            callback(undefined);
        }
    }
}


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
        urlPattern: /https?:\/\/prezi\.com\/(p|view)\/.+/g,
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
    sendToExtension({action: "takeScreenshot"}, function (response) {
        // The worker replies with an empty object when the capture failed, and
        // with nothing at all if it went away mid-request
        if (!response || !response.image) {
            console.warn("No screenshot returned");
            return;
        }
        socket.emit("_forward", {event: "screenshot", data: {image: response.image}});
    });
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
// The remote only ever sends a keyCode. keyCode is deprecated and presentation
// software increasingly reads key/code instead, so derive those as well rather
// than dispatching an event that carries the legacy attribute alone.
var KEY_DESCRIPTORS = {
    8: ["Backspace", "Backspace"],
    9: ["Tab", "Tab"],
    13: ["Enter", "Enter"],
    19: ["Pause", "Pause"],
    27: ["Escape", "Escape"],
    32: [" ", "Space"],
    33: ["PageUp", "PageUp"],
    34: ["PageDown", "PageDown"],
    35: ["End", "End"],
    36: ["Home", "Home"],
    37: ["ArrowLeft", "ArrowLeft"],
    38: ["ArrowUp", "ArrowUp"],
    39: ["ArrowRight", "ArrowRight"],
    40: ["ArrowDown", "ArrowDown"],
    45: ["Insert", "Insert"],
    46: ["Delete", "Delete"],
    188: [",", "Comma"],
    190: [".", "Period"],
    191: ["/", "Slash"]
};

function describeKey(keyCode, ctrlKey, shiftKey, altKey) {
    var key;
    var code;
    var known = KEY_DESCRIPTORS[keyCode];

    if (known) {
        key = known[0];
        code = known[1];
    } else if (keyCode >= 65 && keyCode <= 90) {// A-Z
        var letter = String.fromCharCode(keyCode);
        key = shiftKey ? letter : letter.toLowerCase();
        code = "Key" + letter;
    } else if (keyCode >= 48 && keyCode <= 57) {// 0-9
        key = String.fromCharCode(keyCode);
        code = "Digit" + key;
    } else if (keyCode >= 96 && keyCode <= 105) {// numpad 0-9
        key = String.fromCharCode(keyCode - 48);
        code = "Numpad" + key;
    } else if (keyCode >= 112 && keyCode <= 123) {// F1-F12
        key = "F" + (keyCode - 111);
        code = key;
    } else {
        key = "Unidentified";
        code = "Unidentified";
    }

    return {
        keyCode: keyCode,
        key: key,
        code: code,
        ctrlKey: !!ctrlKey,
        shiftKey: !!shiftKey,
        altKey: !!altKey
    };
}

// This used to build a function with toString() and drop it into the page as an
// inline <script>, because the legacy keyCode/which had to be set as expandos on
// a generic Event, and expandos do not cross into the page's world. Manifest V3
// applies the extension's own CSP ("script-src 'self'") to scripts a content
// script injects, so that inline script is now refused on every site - with or
// without a CSP of its own - and the remote would click through to nothing.
//
// A real KeyboardEvent carries keyCode/which on the event itself rather than on
// a per-world JS wrapper, so the page reads the values it expects and nothing
// has to be injected at all. Dispatching an event is not script execution, so no
// CSP applies to it either.
function simulateKeyEvent(keyCode, ctrlKey, shiftKey, altKey) {
    // Adjust as needed; some events are only processed at certain elements
    var element = document.body || document.documentElement;
    if (!element) {
        console.warn("Nowhere to dispatch the key event to");
        return;
    }

    var descriptor = describeKey(keyCode, ctrlKey, shiftKey, altKey);
    var handled = false;

    // Trigger all 3 just in case
    ["keydown", "keypress", "keyup"].forEach(function (type) {
        var prevented = !element.dispatchEvent(new KeyboardEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            key: descriptor.key,
            code: descriptor.code,
            keyCode: keyCode,
            which: keyCode,
            charCode: 0,
            ctrlKey: descriptor.ctrlKey,
            shiftKey: descriptor.shiftKey,
            altKey: descriptor.altKey
        }));
        console.log("KeyResult (" + type + "): " + prevented);
        handled = handled || prevented;
    });

    if (!handled) {
        console.warn("Simulating key event " + keyCode + " had no effect (probably)");
    }
}

var overlayMessage = {
    show: function (msg) {
        $(".overlay-message-content").text(msg);
        $(".laser-calibration-backdrop").fadeIn();
    },
    hide: function () {
        $(".laser-calibration-backdrop").fadeOut();
        $(".overlay-message-content").empty()
    },
    remote: {
        show: function (msg) {
            socket.emit("_forward", {event: "overlayMessage", action: "show", msg: msg});
        },
        hide: function () {
            socket.emit("_forward", {event: "overlayMessage", action: "hide"});
        }
    }
};
window.rsOverlayMsg = overlayMessage;
socket.on("overlayMessage", function (msg) {
    if (msg.action == "show") {
        overlayMessage.show(msg.msg);
    } else if (msg.action == "hide") {
        overlayMessage.hide();
    }
});

// Shapes overlay.html can draw without the Font Awesome webfont
var LASER_ICONS = ["circle", "circle-o", "dot-circle-o", "square", "star", "crosshairs", "plus", "times"];
var laserPointer = {
    applyStyle: function (client, styles) {
        var element = $("#rs-laser-dot-" + client);
        $.each(styles || {}, function (key, value) {
            element.css(key, value);
        })
        var icon = styles && styles._icon;
        if (LASER_ICONS.indexOf(icon) < 0) {
            icon = "circle";
        }
        var iconElement = element.children().first();
        iconElement.removeClass().addClass("fa").addClass("fa-" + icon);
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

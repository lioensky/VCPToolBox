// ==UserScript==
// @name         SillyTavern Floating Clock & VCP Button (Animated - Soft Circular Ripple)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Adds an animated floating clock (blinking colon) and VCP button with a soft, blurred circular ripple background effect to SillyTavern.
// @author       Xiaoke & Ryan (Modified by Roo, Animations by AI)
// @match        *://localhost:8000/*
// @match        *://127.0.0.1:8000/*
// @match        *://*/*:8000/*
// @include      /^https?:\/\/.*:8000\//
// @grant        GM_addStyle
// @run-at       document_idle
// ==/UserScript==

(function() {
    'use strict';

    console.log('SillyTavern Floating Clock & VCP Button (Animated - Soft Circular Ripple): Script started.');

    function createFloatingClockAndButton() {
        console.log('SillyTavern Floating Clock & VCP Button: Creating elements.');

        const clockContainer = document.createElement('div');
        clockContainer.id = 'st-floating-container';
        const timeElement = document.createElement('div');
        timeElement.id = 'st-clock-time';
        const dateElement = document.createElement('div');
        dateElement.id = 'st-clock-date';
        const adminButton = document.createElement('button');
        adminButton.id = 'st-vcp-admin-button';
        adminButton.textContent = 'VCP管理器';

        clockContainer.appendChild(timeElement);
        clockContainer.appendChild(dateElement);
        clockContainer.appendChild(adminButton);

        GM_addStyle(`
            @keyframes st-colon-blink {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.2; }
            }

            @keyframes st-soft-circular-ripple-effect {
                0% {
                    transform: translate(-50%, -50%) scale(0);
                    opacity: 0.7; /* Start a bit more visible to see the initial soft color */
                }
                80% { /* Ripple expands and fades, hold opacity a bit longer before full fade */
                    transform: translate(-50%, -50%) scale(18); /* Slightly larger scale for a wider soft ripple */
                    opacity: 0;
                }
                100% {
                    transform: translate(-50%, -50%) scale(0); /* Reset for next loop */
                    opacity: 0;
                }
            }

            #st-floating-container {
                position: fixed;
                top: 10px;
                right: 10px;
                z-index: 9999;
                background-color: rgba(48, 49, 54, 0.8);
                backdrop-filter: blur(5px);
                -webkit-backdrop-filter: blur(5px);
                padding: 4px 10px;
                padding-top: 4px;
                border-radius: 8px;
                font-family: 'Segoe UI', Roboto, sans-serif;
                color: #ffffff;
                text-align: center;
                cursor: default;
                overflow: hidden; /* Important for containing the pseudo-element ripple */
            }

            #st-floating-container::before { /* Ripple pseudo-element */
                content: '';
                position: absolute;
                left: 50%;
                top: 50%;
                width: 10px; /* Initial size of the ripple's source */
                height: 10px;
                /* Using a radial gradient for a soft edge */
                background-image: radial-gradient(
                    circle,
                    rgba(190, 210, 240, 0.45) 0%, /* Center color - slightly more opaque */
                    rgba(190, 210, 240, 0.3) 40%, /* Mid color */
                    rgba(190, 210, 240, 0) 70%   /* Edge color - fully transparent */
                );
                border-radius: 50%;
                transform: translate(-50%, -50%) scale(0); /* Initial state: centered and scaled down */
                opacity: 0; /* Start transparent, animation will handle fade-in */
                animation: st-soft-circular-ripple-effect 3.8s ease-out infinite; /* Slightly adjusted timing */
                z-index: 0; /* Behind the content */
                pointer-events: none; /* So it doesn't interfere with clicks */
            }

            #st-clock-time,
            #st-clock-date,
            #st-vcp-admin-button {
                position: relative; /* Needed to ensure z-index works */
                z-index: 1;       /* Place content above the ::before ripple */
            }

            #st-clock-time {
                font-size: 28px;
                font-weight: bold;
                line-height: 1.2;
                margin-top: -3px;
                letter-spacing: 0.5px;
            }

            #st-clock-time .st-clock-colon {
                animation: st-colon-blink 1s infinite;
                position: relative;
            }

            #st-clock-date {
                font-size: 12px;
                margin-top: -2px;
                display: block;
                opacity: 0.9;
            }

            #st-vcp-admin-button {
                display: block;
                margin: 0 auto;
                margin-top: 5px;
                width: 65%;
                padding: 4px 7px;
                border: 1px solid #606060;
                border-radius: 4px;
                background-color: #404040;
                color: #ffffff;
                font-size: 12px;
                cursor: pointer;
                transition: background-color 0.3s ease, box-shadow 0.3s ease;
            }

            #st-vcp-admin-button:hover {
                background-color: #505050;
                box-shadow: 0 0 5px rgba(0, 210, 255, 0.5);
            }
        `);

        adminButton.addEventListener('click', function() {
            window.open('http://192.168.2.179:5890/AdminPanel/', '_blank');
        });

        document.body.appendChild(clockContainer);

        function updateClock() {
            const now = new Date();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');

            timeElement.innerHTML = `${hours}<span class="st-clock-colon">:</span>${minutes}<span class="st-clock-colon">:</span>${seconds}`;

            const dateOptions = { weekday: 'long', month: 'long', day: 'numeric' };
            dateElement.textContent = now.toLocaleDateString(navigator.language || 'en-US', dateOptions);
        }
        updateClock();
        setInterval(updateClock, 1000);
        console.log('SillyTavern Floating Clock & VCP Button: Elements added and clock started.');
    }

    function initializeScript() {
        createFloatingClockAndButton();
        console.log('SillyTavern Floating Clock & VCP Button (Animated - Soft Circular Ripple): Initialized.');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initializeScript();
    } else {
        window.addEventListener('DOMContentLoaded', initializeScript);
    }

})();

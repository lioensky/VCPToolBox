// ==UserScript==
// @name         SillyTavern Floating Clock & VCP Button
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Adds a floating clock (time and date) and a VCP admin button to SillyTavern.
// @author       Xiaoke & Ryan (Modified by Roo)
// @match        *://localhost:8000/*
// @match        *://127.0.0.1:8000/*
// @match        *://*/*:8000/*
// @include      /^https?:\/\/.*:8000\//
// @grant        none
// @run-at       document_idle
// ==/UserScript==

(function() {
    'use strict';

    console.log('SillyTavern Floating Clock & VCP Button: Script started.');

    function createFloatingClockAndButton() {
        console.log('SillyTavern Floating Clock & VCP Button: Creating elements.');
        // Optional: Set a generic title or remove this line if not desired
        // document.title = 'SillyTavern';

        const clockContainer = document.createElement('div');
        clockContainer.id = 'st-floating-container'; // Reverted to a more generic ID or keep specific if preferred
        const timeElement = document.createElement('div');
        timeElement.id = 'st-clock-time';
        const dateElement = document.createElement('div');
        dateElement.id = 'st-clock-date';
        const adminButton = document.createElement('button');
        adminButton.id = 'st-vcp-admin-button'; // New ID for the button
        adminButton.textContent = 'VCP管理器';

        clockContainer.appendChild(timeElement);
        clockContainer.appendChild(dateElement);
        clockContainer.appendChild(adminButton);

        Object.assign(clockContainer.style, {
            position: 'fixed', top: '10px', right: '10px', zIndex: '9999',
            backgroundColor: 'rgba(48, 49, 54, 0.8)', backdropFilter: 'blur(5px)',
            webkitBackdropFilter: 'blur(5px)', padding: '4px 10px', paddingTop: '4px', borderRadius: '8px',
            fontFamily: 'sans-serif', color: '#ffffff', textAlign: 'center', cursor: 'default'
        });
        Object.assign(timeElement.style, { fontSize: '28px', fontWeight: 'bold', lineHeight: '1.2', marginTop: '-3px' });
        Object.assign(dateElement.style, { fontSize: '12px', marginTop: '-2px', display: 'block' });
        Object.assign(adminButton.style, {
            display: 'block', margin: '0 auto',marginTop: '5px', width: '65%', padding: '4px 7px',
            border: '1px solid #606060', borderRadius: '4px', backgroundColor: '#404040',
            color: '#ffffff', fontSize: '12px', cursor: 'pointer', transition: 'background-color 0.3s ease'
        });

        adminButton.addEventListener('mouseover', function() { this.style.backgroundColor = '#505050'; });
        adminButton.addEventListener('mouseout', function() { this.style.backgroundColor = '#404040'; });
        adminButton.addEventListener('click', function() {
            // Ensure this URL is correct and accessible
            window.open('http://192.168.2.179:5890/AdminPanel/', '_blank');
        });

        document.body.appendChild(clockContainer);

        function updateClock() {
            const now = new Date();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            timeElement.textContent = `${hours}:${minutes}:${seconds}`;
            const dateOptions = { weekday: 'long', month: 'long', day: 'numeric' };
            // Consider using browser's locale or a user-configurable one if needed
            dateElement.textContent = now.toLocaleDateString(navigator.language || 'en-US', dateOptions);
        }
        updateClock();
        setInterval(updateClock, 1000);
        console.log('SillyTavern Floating Clock & VCP Button: Elements added.');
    }

    // --- Script Initialization ---
    function initializeScript() {
        createFloatingClockAndButton();
        console.log('SillyTavern Floating Clock & VCP Button: Initialized.');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initializeScript();
    } else {
        window.addEventListener('DOMContentLoaded', initializeScript);
    }

})();
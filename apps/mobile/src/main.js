import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
createApp(App).mount('#app');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/mobile/sw.js',{scope:'/mobile/'}).catch(()=>{});

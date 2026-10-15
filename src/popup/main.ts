import { createApp } from 'vue';
import App from './App.vue';
import { uiLanguage } from '../core/i18n.ts';
import './popup.css';

document.documentElement.lang = uiLanguage(); // screen readers read it in that language
createApp(App).mount('#app');

import { createApp } from 'vue';
import Migrate from './Migrate.vue';
import { uiLanguage } from '../core/i18n.ts';
import './migrate.css';

document.documentElement.lang = uiLanguage(); // screen readers read it in that language
createApp(Migrate).mount('#app');

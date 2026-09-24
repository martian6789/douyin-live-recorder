import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as Icons from '@element-plus/icons-vue'

// Element Plus 基础样式先入，再由 style.css 覆盖主题变量
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './style.css'

import App from './App.vue'

const app = createApp(App)

// 图标全量注册（图标是按需的轻量组件，全量注册最省事）
for (const [name, comp] of Object.entries(Icons)) {
  app.component(name, comp as never)
}

app.use(ElementPlus, { locale: zhCn })
app.mount('#app')

/**
 * plugins/vuetify.ts
 *
 * Framework documentation: https://vuetifyjs.com
 */

// Styles
import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'

// Composables
import { createVuetify, type ThemeDefinition } from 'vuetify'

// Dark medical theme — ベース #0F1419、パネル #1A2028、teal アクセント
const darkMedical: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#0F1419',
    surface: '#1A2028',
    'surface-bright': '#222B36',
    'surface-light': '#2A3441',
    'surface-variant': '#2A3441',
    'on-surface-variant': '#C7D1DA',

    primary: '#00D4AA',           // teal アクセント
    'primary-darken-1': '#00B894',
    secondary: '#7AA2C7',
    'secondary-darken-1': '#5C7E9F',

    accent: '#00D4AA',
    error: '#FF5C7A',
    info: '#3BA3FF',
    success: '#3DDC97',
    warning: '#FFB454',

    'on-background': '#E8EEF2',
    'on-surface': '#E8EEF2',
    'on-primary': '#0F1419',
    'on-secondary': '#0F1419',
  },
  variables: {
    'border-color': '#2A3441',
    'border-opacity': 1,
  },
}

export default createVuetify({
  theme: {
    defaultTheme: 'darkMedical',
    themes: { darkMedical },
  },
  defaults: {
    VBtn: { rounded: 'sm' },
    VCard: { rounded: 'md' },
    VTextField: { variant: 'outlined', density: 'compact' },
    VSelect: { variant: 'outlined', density: 'compact' },
  },
})

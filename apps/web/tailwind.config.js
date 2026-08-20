/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* 品牌色阶：primary 即原 deepSea（#0F3A5C），800 用于 hover 加深 */
        primary: {
          DEFAULT: '#0F3A5C',
          50: '#F0F5FA',
          100: '#DCE8F2',
          200: '#B9D0E2',
          300: '#8DB2CF',
          400: '#5D8FB5',
          500: '#35719C',
          600: '#1D5680',
          700: '#0F3A5C',
          800: '#0C2E4A',
          900: '#082238',
        },
        /* 语义 token 走 CSS 变量（值定义在 index.css），为暗色模式预留切换通道 */
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        panel: 'rgb(var(--c-panel) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        'ink-soft': 'rgb(var(--c-ink-soft) / <alpha-value>)',
        success: 'rgb(var(--c-success) / <alpha-value>)',
        warning: 'rgb(var(--c-warning) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      zIndex: {
        sticky: '10',
        drawer: '50',
        modal: '60',
        toast: '70',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05)',
        pop: '0 8px 24px rgba(15,58,92,0.12)',
      },
      animation: {
        'fade-in': 'fadeIn 150ms ease-out',
        'pulse-bar': 'pulseBar 1.5s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        pulseBar: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.5' },
        },
      },
    },
  },
  plugins: [],
}

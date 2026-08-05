/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        deepSea: '#0F3A5C',
        steelBlue: '#4A6D8C',
        amber: '#D97706',
        success: '#15803D',
        warning: '#CA8A04',
        danger: '#B91C1C',
        bgGray: '#F5F7FA',
        card: '#FFFFFF',
        textDark: '#1F2937',
        textGray: '#6B7280',
        borderGray: '#E5E7EB',
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05)',
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

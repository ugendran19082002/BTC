/** @type {import('tailwindcss').Config} */
export default {
  // Preflight off on purpose: this app has its own hand-written stylesheet and
  // Tailwind's reset would fight it. Tailwind is here for the shadcn-style
  // components only.
  corePlugins: { preflight: false },
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'var(--line)',
        input: 'var(--line)',
        ring: 'var(--accent)',
        background: 'var(--panel)',
        foreground: 'var(--text)',
        muted: { DEFAULT: 'var(--panel-2)', foreground: 'var(--muted)' },
        accent: { DEFAULT: 'var(--panel-2)', foreground: 'var(--text)' },
        primary: { DEFAULT: 'var(--accent)', foreground: '#05121f' },
        popover: { DEFAULT: 'var(--panel)', foreground: 'var(--text)' },
      },
      borderRadius: { lg: '8px', md: '6px', sm: '5px' },
      keyframes: {
        in: { from: { opacity: '0', transform: 'translateY(-4px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { in: 'in 120ms ease-out' },
    },
  },
  plugins: [],
};

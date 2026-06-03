/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/ui/public/index.html',
    './src/ui/views/*.html',
  ],
  theme: {
    extend: {
      colors: {
        // The gh-* palette resolves via CSS variables defined in tokens.css.
        // Markup keeps using bg-gh-bg / text-gh-text / etc. - the values
        // behind each class swap when [data-theme="light"] lands.
        gh: {
          bg: 'var(--color-bg)',
          card: 'var(--color-card)',
          border: 'var(--color-border)',
          border2: 'var(--color-border2)',
          text: 'var(--color-text)',
          muted: 'var(--color-muted)',
          dim: 'var(--color-dim)',
          blue: 'var(--color-blue)',
          green: 'var(--color-green)',
          red: 'var(--color-red)',
          yellow: 'var(--color-yellow)',
          purple: 'var(--color-purple)',
        },
      },
    },
  },
  safelist: [
    // Theme-targeting classes used dynamically and the data-* attribute
    // wrappers Alpine paints based on state.
    'bg-gh-bg', 'bg-gh-card', 'bg-gh-border', 'bg-gh-border2',
    'text-gh-text', 'text-gh-muted', 'text-gh-dim',
    'text-gh-blue', 'text-gh-green', 'text-gh-red', 'text-gh-yellow', 'text-gh-purple',
    'border-gh-border', 'border-gh-border2',
  ],
};

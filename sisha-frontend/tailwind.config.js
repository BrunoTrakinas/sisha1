/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        militar: {
          dark: '#0f172a',
          card: '#1e293b',
          accent: '#3b82f6',
          text: '#f8fafc',
        }
      }
    },
  },
  plugins: [],
}
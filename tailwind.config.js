/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Geist carries no CJK glyphs, so Chinese would render as tofu boxes in
        // the Tauri webview. Append system CJK fallbacks (macOS / Windows /
        // Linux) after Geist — Latin still uses Geist, CJK falls through.
        sans: [
          '"Geist Variable"',
          'ui-sans-serif',
          'system-ui',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"微软雅黑"',
          '"Noto Sans SC"',
          '"Noto Sans CJK SC"',
          'sans-serif',
        ],
        mono: [
          '"Geist Mono Variable"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"Courier New"',
          // CJK fallback for the rare translated label inside a mono context.
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};

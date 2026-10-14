import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// Published on GitHub Pages by .github/workflows/docs.yml. Not part of the Docker image (.dockerignore).
const config: Config = {
  title: 'Sumigo',
  tagline: 'Self-hosted, multi-site Git CMS',
  favicon: 'img/favicon.svg', // 🦑 from Noto Emoji (Apache 2.0, see third_party/noto-emoji)

  url: 'https://ermos.github.io',
  baseUrl: '/sumigo/',
  organizationName: 'ermos',
  projectName: 'sumigo',
  trailingSlash: false,

  onBrokenLinks: 'throw',

  // .md pages are plain CommonMark: braces and angle brackets in the text need no escaping (MDX only for .mdx).
  markdown: {
    format: 'detect',
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/', // the docs are the whole site
          editUrl: 'https://github.com/ermos/sumigo/tree/main/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Sumigo',
      logo: {alt: 'Sumigo', src: 'img/favicon.svg'},
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
        {href: 'https://github.com/ermos/sumigo', label: 'GitHub', position: 'right'},
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {label: 'Installation', to: '/installation'},
        {label: 'sumigo.yml', to: '/configuration/sumigo-yml'},
        {label: 'Releases', href: 'https://github.com/ermos/sumigo/releases'},
        {label: 'GitHub', href: 'https://github.com/ermos/sumigo'},
      ],
      copyright: `© ${new Date().getFullYear()} Sumigo · Built with Docusaurus`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'yaml', 'docker'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;

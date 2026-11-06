import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'OpenCode Router',
  description: 'Automated proxy discovery, testing, and intelligent routing for OpenCode. Fix connectivity issues and IP-based rate limits with Xray/V2Ray on Linux.',
  base: '/OpenCode-Router/',
  cleanUrls: true,
  lastUpdated: true,
  // Keep internal SEO planning documents out of the public documentation site and sitemap.
  srcExclude: [
    '**/BACKLINK_TRACKER.md',
    '**/CONTENT_CALENDAR.md',
    '**/GITHUB_SEO.md',
    '**/KEYWORD_RESEARCH.md',
    '**/PROMOTION_PLAN.md',
    '**/SEO_AUDIT.md',
    '**/SEO_MONITORING.md'
  ],
  sitemap: {
    hostname: 'https://ehsancreator.github.io/OpenCode-Router/'
  },
  transformHead({ pageData }) {
    const cleanPath = pageData.relativePath
      .replace(/(^|\/)index\.md$/, '$1')
      .replace(/\.md$/, '');
    const canonicalUrl = `https://ehsancreator.github.io/OpenCode-Router/${cleanPath}`.replace(/\/+$/, '/');
    const head: [string, Record<string, string>][] = [
      ['link', { rel: 'canonical', href: canonicalUrl }],
      ['meta', { property: 'og:url', content: canonicalUrl }]
    ];
    if (pageData.frontmatter.title) {
      head.push(['meta', { property: 'og:title', content: `${pageData.frontmatter.title} | OpenCode Router` }]);
      head.push(['meta', { name: 'twitter:title', content: `${pageData.frontmatter.title} | OpenCode Router` }]);
    }
    if (pageData.frontmatter.description) {
      head.push(['meta', { property: 'og:description', content: pageData.frontmatter.description }]);
      head.push(['meta', { name: 'twitter:description', content: pageData.frontmatter.description }]);
    }
    return head;
  },
  head: [
    ['meta', { name: 'google-site-verification', content: 'CFmINnfAKd8ec6O0o44UeGgXtt4n6DXwTPft1gg1mmQ' }],
    ['meta', { name: 'theme-color', content: '#0f172a' }],
    ['meta', { name: 'author', content: 'Ehsan Shahriyari' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'OpenCode Router' }],
    ['meta', { property: 'og:title', content: 'OpenCode Router — Intelligent Proxy & Rate-Limit Router for OpenCode' }],
    ['meta', { property: 'og:description', content: 'Automated proxy discovery, testing, and intelligent routing for OpenCode. Fix connectivity issues and IP-based rate limits with Xray/V2Ray on Linux.' }],
    ['meta', { property: 'og:url', content: 'https://ehsancreator.github.io/OpenCode-Router/' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
    ['meta', { name: 'twitter:title', content: 'OpenCode Router — Intelligent Proxy Router for OpenCode' }],
    ['meta', { name: 'twitter:description', content: 'Fix OpenCode connectivity issues and IP-based HTTP 429 rate limits with automated Xray/V2Ray proxy routing on Ubuntu Linux.' }],
    ['meta', { name: 'twitter:creator', content: '@EhsanCreator' }],
    [
      'script',
      { type: 'application/ld+json' },
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'OpenCode Router',
        operatingSystem: 'Ubuntu 24.04 LTS (Linux x86_64)',
        applicationCategory: 'DeveloperApplication',
        offers: {
          '@type': 'Offer',
          price: '0.00',
          priceCurrency: 'USD'
        },
        description: 'Automated proxy discovery, testing, and intelligent routing for OpenCode. Fix connectivity issues and IP-based rate limits with Xray/V2Ray on Linux.',
        author: {
          '@type': 'Person',
          name: 'Ehsan Shahriyari',
          url: 'https://github.com/EhsanCreator'
        },
        url: 'https://ehsancreator.github.io/OpenCode-Router/',
        downloadUrl: 'https://github.com/EhsanCreator/OpenCode-Router/releases',
        license: 'https://opensource.org/licenses/MIT'
      })
    ]
  ],
  themeConfig: {
    siteTitle: 'OpenCode Router',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Articles', link: '/articles/fix-opencode-network-errors-linux' },
      { text: 'Project', link: '/project/architecture' },
      { text: 'v1.0.0 Releases', link: 'https://github.com/EhsanCreator/OpenCode-Router/releases' }
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'User Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Installation on Ubuntu', link: '/guide/installation' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'OpenCode CLI Integration', link: '/guide/opencode-cli-integration' },
            { text: 'Proxy Architecture', link: '/guide/proxy-architecture' },
            { text: 'Supported Protocols', link: '/guide/supported-protocols' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
            { text: 'Security and Privacy', link: '/guide/security-and-privacy' },
            { text: 'Frequently Asked Questions', link: '/guide/faq' }
          ]
        }
      ],
      '/articles/': [
        {
          text: 'Technical Problem Guides',
          items: [
            { text: 'Fix Network Errors on Linux', link: '/articles/fix-opencode-network-errors-linux' },
            { text: 'Fix HTTP 429 Rate Limits', link: '/articles/fix-opencode-http-429-rate-limit' },
            { text: 'Configure Proxy for OpenCode CLI', link: '/articles/configure-proxy-opencode-cli' },
            { text: 'Use Xray with OpenCode on Ubuntu', link: '/articles/use-xray-with-opencode-ubuntu' },
            { text: 'OpenCode Proxy vs System-Wide VPN', link: '/articles/opencode-proxy-vs-system-vpn' }
          ]
        }
      ],
      '/project/': [
        {
          text: 'Project & Community',
          items: [
            { text: 'Architecture Overview', link: '/project/architecture' },
            { text: 'Contributing Guidelines', link: '/project/contributing' },
            { text: 'Security Policy', link: '/project/security' },
            { text: 'Changelog', link: '/project/changelog' },
            { text: 'Author & Credits', link: '/project/author' }
          ]
        }
      ]
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/EhsanCreator/OpenCode-Router' }
    ],
    search: {
      provider: 'local'
    },
    footer: {
      message: 'Released under the MIT License • Fully Isolated User-Space Proxy for Ubuntu Linux',
      copyright: 'Copyright © 2026 Ehsan Shahriyari • @EhsanCreator'
    }
  }
});

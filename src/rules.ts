import type { Category, Severity, TrackerRule } from "./types.js";

/**
 * Severity per category when the service is contacted before any consent
 * interaction. This is a technical rating, not a legal conclusion: analytics,
 * advertising and tag managers generally need prior consent; the rest is
 * flagged so a human can decide.
 */
export const CATEGORY_SEVERITY: Record<Category, Severity> = {
  analytics: "error",
  advertising: "error",
  "tag-manager": "warn",
  fonts: "error",
  social: "warn",
  chat: "warn",
  maps: "warn",
  video: "warn",
  cdn: "warn",
  captcha: "info",
  "consent-platform": "info",
};

export const CATEGORY_HINT: Record<Category, string> = {
  analytics: "Measurement service contacted before any consent interaction.",
  advertising: "Advertising or retargeting service contacted before any consent interaction.",
  "tag-manager": "Tag manager contacted before any consent interaction. Some setups use a consent mode that blocks its tags until consent; the analytics and advertising findings show what it actually loaded.",
  fonts: "Fonts are fetched from a third party, which transfers the visitor's IP address. Self-hosting avoids this.",
  social: "Social-network resource contacted before any consent interaction.",
  chat: "Chat or support widget contacted before any consent interaction.",
  maps: "Map service contacted before any consent interaction.",
  video: "Video platform contacted before any consent interaction.",
  cdn: "Resource loaded from a public CDN, which transfers the visitor's IP address. Self-hosting avoids this.",
  captcha: "Bot-protection service contacted; check whether it is required for a form on this page.",
  "consent-platform": "Consent management platform loaded. This is expected for a banner and listed only for context.",
};

export const BUILT_IN_RULES: TrackerRule[] = [
  // Analytics
  { id: "google-analytics", name: "Google Analytics", category: "analytics", hosts: ["google-analytics.com", "analytics.google.com", "stats.g.doubleclick.net"] },
  { id: "matomo-cloud", name: "Matomo Cloud", category: "analytics", hosts: ["matomo.cloud"] },
  { id: "plausible", name: "Plausible (hosted)", category: "analytics", hosts: ["plausible.io"] },
  { id: "hotjar", name: "Hotjar", category: "analytics", hosts: ["hotjar.com", "hotjar.io"] },
  { id: "clarity", name: "Microsoft Clarity", category: "analytics", hosts: ["clarity.ms"] },
  { id: "mixpanel", name: "Mixpanel", category: "analytics", hosts: ["mixpanel.com"] },
  { id: "segment", name: "Segment", category: "analytics", hosts: ["segment.com", "segment.io"] },
  { id: "fullstory", name: "FullStory", category: "analytics", hosts: ["fullstory.com"] },
  { id: "heap", name: "Heap", category: "analytics", hosts: ["heap.io", "heapanalytics.com"] },
  { id: "amplitude", name: "Amplitude", category: "analytics", hosts: ["amplitude.com"] },
  { id: "vercel-analytics", name: "Vercel Analytics", category: "analytics", hosts: ["vercel-insights.com", "vitals.vercel-insights.com"] },
  { id: "adobe-analytics", name: "Adobe Analytics", category: "analytics", hosts: ["omtrdc.net", "2o7.net"] },
  // Tag managers
  { id: "adobe-launch", name: "Adobe Launch (tag manager)", category: "tag-manager", hosts: ["adobedtm.com"] },
  { id: "google-tag-manager", name: "Google Tag Manager", category: "tag-manager", hosts: ["googletagmanager.com"] },
  // Advertising
  { id: "google-ads", name: "Google Ads / DoubleClick", category: "advertising", hosts: ["doubleclick.net", "googlesyndication.com", "googleadservices.com"] },
  { id: "meta-pixel", name: "Meta Pixel / Facebook SDK", category: "advertising", hosts: ["connect.facebook.net"] },
  { id: "meta-tr", name: "Meta Pixel (tr endpoint)", category: "advertising", hosts: ["facebook.com", "www.facebook.com"], pathPrefix: "/tr" },
  { id: "linkedin-insight", name: "LinkedIn Insight Tag", category: "advertising", hosts: ["snap.licdn.com", "px.ads.linkedin.com"] },
  { id: "tiktok-pixel", name: "TikTok Pixel", category: "advertising", hosts: ["analytics.tiktok.com"] },
  { id: "x-ads", name: "X (Twitter) Ads", category: "advertising", hosts: ["static.ads-twitter.com", "ads.twitter.com"] },
  { id: "bing-ads", name: "Microsoft Advertising", category: "advertising", hosts: ["bat.bing.com"] },
  { id: "pinterest-tag", name: "Pinterest Tag", category: "advertising", hosts: ["ct.pinterest.com"] },
  { id: "adobe-audience", name: "Adobe Audience Manager / Advertising Cloud", category: "advertising", hosts: ["demdex.net", "everesttech.net"] },
  { id: "criteo", name: "Criteo", category: "advertising", hosts: ["criteo.com", "criteo.net"] },
  { id: "taboola", name: "Taboola", category: "advertising", hosts: ["taboola.com"] },
  { id: "outbrain", name: "Outbrain", category: "advertising", hosts: ["outbrain.com"] },
  // Fonts
  { id: "google-fonts", name: "Google Fonts", category: "fonts", hosts: ["fonts.googleapis.com", "fonts.gstatic.com"] },
  { id: "adobe-fonts", name: "Adobe Fonts", category: "fonts", hosts: ["use.typekit.net", "p.typekit.net"] },
  // Maps
  { id: "google-maps", name: "Google Maps", category: "maps", hosts: ["maps.googleapis.com", "maps.gstatic.com"] },
  { id: "openstreetmap-tiles", name: "OpenStreetMap tiles", category: "maps", hosts: ["tile.openstreetmap.org"] },
  { id: "mapbox", name: "Mapbox", category: "maps", hosts: ["api.mapbox.com"] },
  // Video
  { id: "youtube", name: "YouTube", category: "video", hosts: ["youtube.com", "youtube-nocookie.com", "ytimg.com", "youtu.be"] },
  { id: "vimeo", name: "Vimeo", category: "video", hosts: ["vimeo.com", "vimeocdn.com"] },
  // Social
  { id: "x-widgets", name: "X (Twitter) widgets", category: "social", hosts: ["platform.twitter.com"] },
  { id: "linkedin-platform", name: "LinkedIn platform", category: "social", hosts: ["platform.linkedin.com"] },
  { id: "addthis", name: "AddThis", category: "social", hosts: ["addthis.com"] },
  { id: "sharethis", name: "ShareThis", category: "social", hosts: ["sharethis.com"] },
  // Chat
  { id: "intercom", name: "Intercom", category: "chat", hosts: ["intercom.io", "intercomcdn.com"] },
  { id: "crisp", name: "Crisp", category: "chat", hosts: ["crisp.chat"] },
  { id: "tawk", name: "tawk.to", category: "chat", hosts: ["tawk.to"] },
  { id: "hubspot-tracking", name: "HubSpot tracking", category: "analytics", hosts: ["track.hubspot.com", "track-eu1.hubspot.com", "hs-analytics.net", "hs-banner.com", "hsadspixel.net"] },
  { id: "hubspot", name: "HubSpot (forms, chat, scripts)", category: "chat", hosts: ["hs-scripts.com", "hsforms.net", "hubspot.com"] },
  { id: "drift", name: "Drift", category: "chat", hosts: ["drift.com", "driftt.com"] },
  { id: "zendesk-widget", name: "Zendesk widget", category: "chat", hosts: ["zdassets.com"] },
  { id: "tidio", name: "Tidio", category: "chat", hosts: ["tidio.co", "tidiochat.com"] },
  // Public CDNs
  { id: "cdnjs", name: "cdnjs", category: "cdn", hosts: ["cdnjs.cloudflare.com"] },
  { id: "jsdelivr", name: "jsDelivr", category: "cdn", hosts: ["cdn.jsdelivr.net"] },
  { id: "unpkg", name: "unpkg", category: "cdn", hosts: ["unpkg.com"] },
  { id: "google-hosted-libs", name: "Google Hosted Libraries", category: "cdn", hosts: ["ajax.googleapis.com"] },
  { id: "jquery-cdn", name: "jQuery CDN", category: "cdn", hosts: ["code.jquery.com"] },
  { id: "bootstrap-cdn", name: "Bootstrap CDN", category: "cdn", hosts: ["stackpath.bootstrapcdn.com", "maxcdn.bootstrapcdn.com"] },
  { id: "wp-stats", name: "WordPress.com / Jetpack stats", category: "analytics", hosts: ["stats.wp.com", "pixel.wp.com"] },
  { id: "newrelic", name: "New Relic", category: "analytics", hosts: ["newrelic.com", "nr-data.net"] },
  { id: "google-ad-services", name: "Google ad services", category: "advertising", hosts: ["googletagservices.com", "adservice.google.com"] },
  // More embeds and widgets
  { id: "google-maps-embed", name: "Google Maps (embed)", category: "maps", hosts: ["google.com", "www.google.com"], pathPrefix: "/maps" },
  { id: "meta-plugins", name: "Facebook plugins", category: "social", hosts: ["facebook.com", "www.facebook.com"], pathPrefix: "/plugins" },
  { id: "instagram", name: "Instagram", category: "social", hosts: ["instagram.com", "cdninstagram.com"] },
  { id: "tiktok-embed", name: "TikTok", category: "social", hosts: ["tiktok.com", "tiktokcdn.com"] },
  { id: "pinterest-widgets", name: "Pinterest widgets", category: "social", hosts: ["assets.pinterest.com"] },
  { id: "x-syndication", name: "X (Twitter) embeds", category: "social", hosts: ["syndication.twitter.com"] },
  { id: "spotify", name: "Spotify", category: "video", hosts: ["open.spotify.com", "spotifycdn.com"] },
  { id: "soundcloud", name: "SoundCloud", category: "video", hosts: ["soundcloud.com", "sndcdn.com"] },
  // Public CDNs and WordPress defaults
  { id: "gravatar", name: "Gravatar", category: "cdn", hosts: ["gravatar.com"] },
  { id: "wp-emoji", name: "WordPress emoji CDN", category: "cdn", hosts: ["s.w.org"] },
  { id: "fontawesome-cdn", name: "Font Awesome CDN", category: "cdn", hosts: ["use.fontawesome.com", "kit.fontawesome.com"] },
  // Consent management platforms (context only)
  { id: "onetrust-cmp", name: "OneTrust", category: "consent-platform", hosts: ["cookielaw.org", "onetrust.com"] },
  { id: "cookiebot-cmp", name: "Cookiebot", category: "consent-platform", hosts: ["consent.cookiebot.com", "consentcdn.cookiebot.com"] },
  { id: "usercentrics-cmp", name: "Usercentrics", category: "consent-platform", hosts: ["usercentrics.eu"] },
  { id: "didomi-cmp", name: "Didomi", category: "consent-platform", hosts: ["privacy-center.org"] },
  { id: "sourcepoint-cmp", name: "Sourcepoint", category: "consent-platform", hosts: ["sp-prod.net", "privacymanager.io", "consensu.org"] },
  { id: "consentmanager-cmp", name: "consentmanager", category: "consent-platform", hosts: ["consentmanager.net"] },
  { id: "iubenda-cmp", name: "iubenda", category: "consent-platform", hosts: ["iubenda.com"] },
  { id: "cookieyes-cmp", name: "CookieYes", category: "consent-platform", hosts: ["cdn-cookieyes.com"] },
  { id: "termly-cmp", name: "Termly", category: "consent-platform", hosts: ["termly.io"] },
  { id: "cookie-script-cmp", name: "Cookie-Script", category: "consent-platform", hosts: ["cookie-script.com"] },
  { id: "osano-cmp", name: "Osano", category: "consent-platform", hosts: ["osano.com"] },
  // Bot protection
  { id: "recaptcha", name: "Google reCAPTCHA", category: "captcha", hosts: ["google.com", "www.google.com", "gstatic.com", "www.gstatic.com", "recaptcha.net", "www.recaptcha.net"], pathPrefix: "/recaptcha" },
  { id: "hcaptcha", name: "hCaptcha", category: "captcha", hosts: ["hcaptcha.com"] },
  { id: "turnstile", name: "Cloudflare Turnstile", category: "captcha", hosts: ["challenges.cloudflare.com"] },
];

/** Cookie names that are set by well-known measurement or advertising services. */
export const TRACKER_COOKIE_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /^_ga($|_)/, name: "Google Analytics" },
  { pattern: /^_gid$/, name: "Google Analytics" },
  { pattern: /^_gat/, name: "Google Analytics" },
  { pattern: /^_gcl_/, name: "Google Ads" },
  { pattern: /^_fbp$|^_fbc$/, name: "Meta Pixel" },
  { pattern: /^_hj/, name: "Hotjar" },
  { pattern: /^_clck$|^_clsk$/, name: "Microsoft Clarity" },
  { pattern: /^_pk_(id|ses|ref|cvar)/, name: "Matomo" },
  { pattern: /^_ttp$|^_tt_/, name: "TikTok" },
  { pattern: /^_pin_unauth$|^_pinterest_/, name: "Pinterest" },
  { pattern: /^ajs_(anonymous_id|user_id)$/, name: "Segment" },
  { pattern: /^mp_.*_mixpanel$/, name: "Mixpanel" },
  { pattern: /^AMCVS?_|^kndctr_.*AdobeOrg/, name: "Adobe Experience Cloud" },
];

/** Cookies that a consent-management platform uses to store the visitor's choice. */
export const CONSENT_COOKIE_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /^_sp_(su|v1_)/, name: "Sourcepoint" },
  { pattern: /^euconsent-v2$/, name: "IAB TCF" },
  { pattern: /^Optanon(Consent|AlertBoxClosed)$/, name: "OneTrust" },
  { pattern: /^CookieConsent$/, name: "Cookiebot" },
  { pattern: /^usercentrics/i, name: "Usercentrics" },
  { pattern: /^borlabs-cookie/, name: "Borlabs Cookie" },
  { pattern: /^cookieyes-consent$/, name: "CookieYes" },
  { pattern: /^cmplz_/, name: "Complianz" },
  { pattern: /^complianz_/, name: "Complianz" },
  { pattern: /^moove_gdpr_popup$/, name: "GDPR Cookie Compliance" },
  { pattern: /^__cmp(cc|consent|iab|cvc)/, name: "consentmanager" },
];

/** Bot protection and load balancing cookies; usually technically necessary. */
export const INFRA_COOKIE_PATTERNS: RegExp[] = [/^__cf_bm$/, /^cf_clearance$/, /^__cfruid$/];

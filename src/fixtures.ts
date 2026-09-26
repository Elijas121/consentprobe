import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const FOOTER = `<footer><a href="/impressum">Impressum</a> <a href="/datenschutz">Datenschutz</a></footer>`;

function page(body: string, head = "", lang = "de"): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>t</title>${head}</head><body><main>${body}</main></body></html>`;
}

export type BannerKind = "good" | "bad" | "no-reject" | "delayed" | "borlabs-style" | "text-link-reject" | "consent-mode" | "kept-cookie";

/** A fake consent banner. "bad" keeps loading the analytics script after reject. */
function bannerPage(kind: BannerKind, thirdOrigin: string): string {
  const borlabs = kind === "borlabs-style";
  const textLink = kind === "text-link-reject";
  const rejectButton =
    kind === "no-reject" ? "" : `<button id="rej" type="button">${borlabs ? "Nur essenzielle Cookies akzeptieren" : textLink ? "Nur essenzielle" : "Alle ablehnen"}</button>`;
  const onReject =
    kind === "bad"
      ? `document.cookie='_ga=GA1.2.9; path=/'; load();`
      : kind === "consent-mode"
        ? `new Image().src='${thirdOrigin}/g/collect?v=2&gcs=G100&gcd=13p3p3p2p5l1';`
        : "";
  const preset = kind === "kept-cookie" ? `document.cookie='_ga=GA1.2.preset; path=/';` : "";
  const delay = kind === "delayed" ? `setTimeout(function(){ banner.style.display='block'; }, 1200);` : "";
  return page(
    `<h1>Banner ${kind}</h1>${FOOTER}
     <div id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1rem;${kind === "delayed" ? "display:none" : ""}">
       <p>Wir verwenden Cookies.</p>
       <button id="acc" type="button">${borlabs ? "Ich akzeptiere alle" : "Alle akzeptieren"}</button>${rejectButton}
     </div>
     <script>
       ${preset}
       var banner = document.getElementById('banner');
       function load(){ var s=document.createElement('script'); s.src='${thirdOrigin}/analytics.js'; document.head.appendChild(s); }
       document.getElementById('acc').addEventListener('click', function(){ document.cookie='_ga=GA1.2.1; path=/'; load(); banner.remove(); });
       var rej = document.getElementById('rej');
       if (rej) rej.addEventListener('click', function(){ ${onReject} banner.remove(); });
       ${delay}
     </script>`,
  );
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as AddressInfo).port)));
}

export interface Fixtures {
  /** First-party origin (hostname "localhost"). */
  origin: string;
  /** Third-party host used by the tracked page (hostname "127.0.0.1"). */
  thirdPartyHost: string;
  /** True once the third-party server received an Authorization header. */
  thirdPartySawCredentials: () => boolean;
  /** How many visits asked the late-banner fixture for a ticket since the last reset. */
  lateTicketCount: () => number;
  /** Forget the late-banner tickets of earlier tests, so each test starts from a fresh counter. */
  resetLateTickets: () => void;
  close: () => Promise<void>;
}

export async function startFixtures(): Promise<Fixtures> {
  let thirdPartyAuthorization = false;
  const third = createServer((req, res) => {
    if (req.headers.authorization) thirdPartyAuthorization = true;
    if (req.url?.startsWith("/auth-probe")) {
      // A third party that asks every visitor for a login: it must never get the credentials of the scanned site.
      res.writeHead(401, { "www-authenticate": 'Basic realm="tracker"', "content-type": "text/html" });
      res.end();
      return;
    }
    if (req.url?.startsWith("/stall")) {
      // A third-party widget whose server never answers. Playwright's isVisible()/count() on this
      // frame wait forever; this is what made real scans hang.
      return;
    }
    if (req.url?.startsWith("/bot-check")) {
      // A consent platform frame that answers headless browsers differently (it sees only its own headers).
      const bot = /HeadlessChrome/.test(`${req.headers["user-agent"] ?? ""} ${req.headers["sec-ch-ua"] ?? ""}`);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(bot ? "<script>parent.postMessage('consentprobe-fixture-bot','*')</script>" : "<p>ok</p>");
      return;
    }
    if (req.url?.startsWith("/embed-frame")) {
      // A third-party embed (think video player) that loads a font file for itself.
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<p>player</p><img src="/font.woff2" alt="">`);
      return;
    }
    if (req.url?.startsWith("/landing")) {
      // The page a site redirects to on another domain; it loads a file from the domain the user typed.
      const back = new URL(req.url, "http://x").searchParams.get("back") ?? "";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html lang="de"><body><h1>Landing</h1><img src="${back}/px.gif" alt=""></body></html>`);
      return;
    }
    if (req.url?.startsWith("/analytics.js")) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("/* fake analytics */");
    } else {
      res.writeHead(200, { "content-type": "image/gif" });
      res.end();
    }
  });
  const thirdPort = await listen(third, "127.0.0.1");
  const thirdOrigin = `http://127.0.0.1:${thirdPort}`;

  let lateTickets = 0;
  const first = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const html = (status: number, body: string, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    switch (path) {
      case "/clean":
        return html(200, page(`<h1>Clean</h1>${FOOTER}`));
      case "/tracked":
        return html(
          200,
          page(`<h1>Tracked</h1>${FOOTER}`, `<script src="${thirdOrigin}/analytics.js"></script>`),
          { "set-cookie": ["_ga=GA1.2.123; Path=/; Max-Age=63072000", "session=abc; Path=/"] },
        );
      case "/no-legal":
        return html(200, page(`<h1>No legal links</h1>`));
      case "/broken-legal":
        return html(200, page(`<footer><a href="/gone-impressum">Impressum</a> <a href="/datenschutz">Datenschutz</a></footer>`));
      case "/legal-outside-footer":
        return html(200, page(`<a href="/impressum">Impressum</a> <a href="/datenschutz">Datenschutz</a>`));
      case "/banner-good":
        return html(200, bannerPage("good", thirdOrigin));
      case "/banner-bad":
        return html(200, bannerPage("bad", thirdOrigin));
      case "/banner-no-reject":
        return html(200, bannerPage("no-reject", thirdOrigin));
      case "/banner-delayed":
        return html(200, bannerPage("delayed", thirdOrigin));
      case "/banner-borlabs-style":
        return html(200, bannerPage("borlabs-style", thirdOrigin));
      case "/banner-text-link-reject":
        return html(200, bannerPage("text-link-reject", thirdOrigin));
      case "/banner-consent-mode":
        return html(200, bannerPage("consent-mode", thirdOrigin));
      case "/banner-kept-cookie":
        return html(200, bannerPage("kept-cookie", thirdOrigin));
      case "/banner-toggle-only":
        // Cookie overlay whose only control is a "save settings" button: not automatable.
        return html(200, page(`<h1>Toggle banner</h1>${FOOTER}<div style="position:fixed;bottom:0;right:0;width:320px;height:200px;background:#fff;padding:1rem"><p>Wir verwenden Cookies und Dienste Dritter.</p><label><input type="checkbox"> Ich akzeptiere die Verwendung von Cookies</label><button type="button">Einstellungen speichern</button></div>`));
      case "/banner-shopify":
        // Shopify privacy banner with renamed buttons: only the element ids identify them.
        return html(200, page(`<h1>Shop</h1>${FOOTER}<section id="shopify-pc__banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1rem"><p>We use cookies.</p><button id="shopify-pc__banner__btn-accept" type="button">Ok</button><button id="shopify-pc__banner__btn-decline" type="button">No Thanks</button></section><script>document.querySelectorAll('#shopify-pc__banner button').forEach(function(b){b.addEventListener('click',function(){document.getElementById('shopify-pc__banner').remove();});});</script>`));
      case "/newsletter-popup":
        // Not a cookie banner: its "No thanks" must never be clicked as a reject.
        return html(200, page(`<h1>Newsletter</h1>${FOOTER}<div role="dialog" style="position:fixed;top:20%;left:20%;width:400px;height:200px;background:#fff"><p>Get 10% off your first order!</p><input placeholder="Email"><button type="button">Subscribe</button><button type="button">No thanks</button></div>`));
      case "/notice-bar":
        // Thin information bar (30 px), no choice offered.
        return html(200, page(`<h1>Notice</h1>${FOOTER}<div style="position:fixed;bottom:0;left:0;right:0;height:30px;background:#036;color:#fff">Hinweis: Es werden nur technisch notwendige Cookies eingesetzt. <span onclick="this.parentNode.remove()">OK</span></div>`));
      case "/banner-heartbeat":
        // A tracker pings every 20 ms until the visitor presses reject, then stops at once:
        // correct behaviour, so nothing may be reported "after reject", screenshots or not.
        return html(200, page(`<h1>Heartbeat</h1>${FOOTER}<div id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1rem"><p>Wir verwenden Cookies.</p><button id="acc" type="button">Alle akzeptieren</button><button id="rej" type="button">Alle ablehnen</button></div><script>var t=setInterval(function(){new Image().src='${thirdOrigin}/beat.gif?'+Math.random();},20);document.getElementById('rej').addEventListener('pointerdown',function(){clearInterval(t);});document.getElementById('acc').addEventListener('pointerdown',function(){clearInterval(t);});document.querySelectorAll('#banner button').forEach(function(b){b.addEventListener('click',function(){document.getElementById('banner').remove();});});</script>`));
      case "/banner-mockup":
        // A marketing mock-up inside the page content, not a real overlay: must never be clicked.
        return html(200, page(`<h1>Demo</h1>${FOOTER}<div class="demo"><button type="button">Ich akzeptiere alle</button><button type="button">Nur Essenzielle Cookies akzeptieren</button></div>`));
      case "/english-no-legal":
        return html(200, page(`<h1>English page</h1>`, "", "en"));
      case "/slow-resource":
        // The HTML arrives at once, but one image never finishes: the "load" event never fires.
        return html(200, page(`<h1>Slow</h1>${FOOTER}<img src="/hang.png" alt="">`));
      case "/hang.png":
        res.writeHead(200, { "content-type": "image/png" });
        res.write(Buffer.alloc(10));
        return; // never ends
      case "/hung-after-load":
        // The page's own script blocks the browser right after load.
        return html(200, page(`<h1>Hung</h1>${FOOTER}<script>addEventListener('load',function(){setTimeout(function(){for(;;){}},100)})</script>`));
      case "/stalled-frame":
        return html(200, page(`<h1>Frame</h1>${FOOTER}<iframe src="${thirdOrigin}/stall" title="widget"></iframe>`));
      case "/stalled-frame-with-banner":
        return html(200, bannerPage("good", thirdOrigin).replace("</main>", `<iframe src="${thirdOrigin}/stall" title="widget"></iframe></main>`));
      case "/banner-hidden-from-bots": {
        // Like several large sites: a headless browser gets no banner, and tracking starts at once.
        // The server looks at the user agent and client hints, the page script at navigator.userAgentData.
        const agent = `${req.headers["user-agent"] ?? ""} ${req.headers["sec-ch-ua"] ?? ""}`;
        if (/HeadlessChrome/.test(agent)) {
          return html(200, page(`<h1>Bot view</h1>${FOOTER}`, `<script src="${thirdOrigin}/analytics.js"></script>`));
        }
        const hideForBots = `<iframe src="${thirdOrigin}/bot-check" title="cmp" style="width:1px;height:1px;border:0"></iframe><script>function botView(){var b=document.getElementById('banner');if(!b)return;b.remove();var s=document.createElement('script');s.src='${thirdOrigin}/analytics.js';document.head.appendChild(s);}if(((navigator.userAgentData||{}).brands||[]).some(function(b){return /HeadlessChrome/.test(b.brand)}))botView();addEventListener('message',function(e){if(e.data==='consentprobe-fixture-bot')botView();});</script>`;
        return html(200, bannerPage("good", thirdOrigin).replace("</main>", `${hideForBots}</main>`));
      }
      case "/banner-plain-controls":
        // Controls built from links without href: no button or link role (seen on a large comparison site).
        return html(200, page(`<h1>Plain controls</h1>${FOOTER}<div id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1rem"><p>Mit einem Klick auf „Geht klar“ erlauben Sie Cookies für Statistik und Werbung. Mit „Nur notwendige Cookies“ speichern wir nur technisch notwendige Cookies.</p><a class="rej">Nur notwendige Cookies</a> <a class="acc">Geht klar</a></div><script>var banner=document.getElementById('banner');function load(){var s=document.createElement('script');s.src='${thirdOrigin}/analytics.js';document.head.appendChild(s);}document.querySelector('.acc').addEventListener('click',function(){document.cookie='_ga=GA1.2.1; path=/';load();banner.remove();});document.querySelector('.rej').addEventListener('click',function(){banner.remove();});</script>`));
      case "/banner-shadow-plain-controls":
        // Plain clickable controls inside an open shadow root: no button or link role in the document,
        // and not reachable through a "body *" query (seen in banners built as web components).
        return html(200, page(`<h1>Shadow plain controls</h1>${FOOTER}<div id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1rem"></div><script>
          var host = document.getElementById('banner');
          var root = host.attachShadow({ mode: 'open' });
          root.innerHTML = '<p>Wir verwenden Cookies.</p><div class="rej" style="cursor:pointer">Alle ablehnen</div> <div class="acc" style="cursor:pointer">Alle akzeptieren</div>';
          root.querySelector('.rej').addEventListener('click', function(){ host.remove(); });
          root.querySelector('.acc').addEventListener('click', function(){ document.cookie='_ga=GA1.2.1; path=/'; host.remove(); });
        </script>`));
      case "/banner-category-list":
      case "/banner-category-list-no-reject": {
        // A consent dialog that lists categories on the first layer: a checkbox label "Essential", an
        // accordion header "Notwendige Cookies" and a switch "Necessary". None of them is a decision.
        const reject = path === "/banner-category-list" ? `<button type="button" class="rej">Accept Only Essential Cookies</button>` : "";
        return html(200, page(`<h1>Category list</h1>${FOOTER}<div id="banner" role="dialog" style="position:fixed;top:10%;left:25%;width:50%;background:#fff;padding:1rem"><p>We use cookies.</p><ul><li><label style="cursor:pointer"><input type="checkbox" checked disabled> <span style="cursor:pointer">Essential</span></label></li><li><button type="button" aria-expanded="false">Notwendige Cookies</button></li><li><span role="switch" aria-checked="true" tabindex="0" style="cursor:pointer">Necessary</span></li></ul><button type="button" class="save">Save Consent</button><button type="button" class="acc">I Accept All</button>${reject}</div><script>document.querySelectorAll('#banner .save, #banner .acc, #banner .rej').forEach(function(b){b.addEventListener('click',function(){document.getElementById('banner').remove();});});</script>`));
      }
      case "/banner-inline-top":
        // A consent bar at the top of the page that pushes the content down (no fixed position, no dialog
        // role); only its container name says what it is. Seen on a large software vendor's site.
        return html(200, page(`<div id="consentBannerCtrl" role="alert"><p>Wir verwenden optionale Cookies. <a href="/datenschutz">Datenschutzerklärung</a></p><button type="button" class="acc">Annehmen</button><button type="button" class="rej">Ablehnen</button><button type="button">Cookies verwalten</button></div><h1>Inline banner</h1><p>Content</p>${FOOTER}<script>document.querySelectorAll('#consentBannerCtrl .acc, #consentBannerCtrl .rej').forEach(function(b){b.addEventListener('click',function(){document.getElementById('consentBannerCtrl').remove();});});</script>`));
      case "/bot-challenge":
        // A bot check that answers HTTP 200 (like a "just a moment" interstitial): not the site.
        return html(200, `<!doctype html><html lang="de"><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking your browser before accessing the site.</div></body></html>`);
      case "/push-prompt":
        // A push-notification prompt in a fixed overlay: "Ablehnen" and "Erlauben" are no cookie decision.
        return html(200, page(`<h1>Shop</h1>${FOOTER}<div role="dialog" style="position:fixed;top:0;left:30%;width:40%;background:#fff;padding:1rem"><p>Möchten Sie Benachrichtigungen über neue Angebote erhalten?</p><button type="button">Ablehnen</button><button type="button">Erlauben</button></div>`));
      case "/csp-blocked":
        // The page's own Content Security Policy stops the tracker: nothing reaches the third party.
        return html(200, page(`<h1>CSP</h1>${FOOTER}<img src="${thirdOrigin}/px.gif" alt="">`, `<script src="${thirdOrigin}/analytics.js"></script>`), {
          "content-security-policy": "img-src 'self'; script-src 'self'",
        });
      case "/embed-font":
        return html(200, page(`<h1>Embed</h1>${FOOTER}<iframe src="${thirdOrigin}/embed-frame" title="player"></iframe>`));
      case "/page-font":
        return html(200, page(`<h1>Font</h1>${FOOTER}<img src="${thirdOrigin}/font.woff2" alt="">`));
      case "/legal-cookie":
        return html(200, page(`<h1>Legal cookie</h1><footer><a href="/impressum-cookie">Impressum</a> <a href="/datenschutz">Datenschutz</a></footer>`));
      case "/impressum-cookie":
        // A legal page that sets a cookie of its own: consentprobe's link check must not count it.
        return html(200, page(`<h1>Impressum</h1>`), { "set-cookie": "legal_check=1; Path=/; Max-Age=3600" });
      case "/redirect-away":
        return html(302, "", { location: `${thirdOrigin}/landing?back=${encodeURIComponent(`http://localhost:${firstPort}`)}` });
      case "/probe-identity":
        // Reports what the site sees: navigator.webdriver and the Accept-Language header, as image paths.
        return html(200, page(`<h1>Identity</h1>${FOOTER}<img src="/al/${encodeURIComponent(String(req.headers["accept-language"] ?? ""))}.gif" alt="">`, `<script>new Image().src = "/wd-" + navigator.webdriver + ".gif";</script>`));
      case "/banner-input-buttons":
        // Controls built from <input type="button|submit">: their label is the value attribute.
        return html(200, page(`<h1>Inputs</h1>${FOOTER}<form id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1rem"><p>Wir verwenden Cookies.</p><input type="button" value="Alle ablehnen"> <input type="submit" value="Alle akzeptieren"></form><script>document.querySelectorAll('#banner input, #banner a, #banner button').forEach(function(b){b.addEventListener('click',function(e){e.preventDefault();document.getElementById('banner').remove();});});</script>`));
      case "/banner-shadow":
        // The banner's content lives in the open shadow root of a web component inside a fixed host.
        return html(200, page(`<h1>Shadow</h1>${FOOTER}<div id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff"><cookie-box></cookie-box></div><script>customElements.define('cookie-box', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<div><p>Wir verwenden Cookies.</p><button id="rej">Alle ablehnen</button><button id="acc">Alle akzeptieren</button></div>'; r.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => document.getElementById('banner').remove())); } });</script>`));
      case "/banner-sticky-buttons":
        // The consent text sits in a fixed banner; the buttons sit in a sticky row of their own inside it (Termly).
        return html(200, page(`<h1>Sticky</h1>${FOOTER}<div id="banner" role="region" style="position:fixed;bottom:0;left:0;right:0;max-height:40vh;overflow:auto;background:#fff"><div><p>Wir verwenden Cookies, um die Website zu verbessern.</p><div style="position:sticky;bottom:0;background:#eee"><button id="rej">Ablehnen</button><button id="acc">Akzeptieren</button></div></div></div><script>document.querySelectorAll('#banner button').forEach(function(b){b.addEventListener('click',function(){document.getElementById('banner').remove();});});</script>`));
      case "/banner-shadow-split":
        // The text and the buttons live in two sibling web components inside a third one: no single innerText holds both.
        return html(200, page(`<h1>Split</h1>${FOOTER}<div id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff"><cmp-root></cmp-root></div><script>
          customElements.define('cmp-text', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<p>Wir verwenden Cookies.</p>'; } });
          customElements.define('cmp-buttons', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<div><button>Ablehnen</button><button>Akzeptieren</button></div>'; r.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => document.getElementById('banner').remove())); } });
          customElements.define('cmp-root', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<style>.cookie{}</style><div><cmp-text></cmp-text><cmp-buttons></cmp-buttons></div>'; } });
        </script>`));
      case "/video-placeholder-late-banner":
        // A consent tool's content blocker in the page ("load this video") comes first in the DOM; the real banner renders later.
        return html(200, page(`<h1>Videos</h1><div class="video-consent"><p>Mit dem Laden des Videos akzeptieren Sie die Datenschutzerklärung von YouTube.</p><button type="button">Akzeptieren</button></div>${FOOTER}`, `<script>setTimeout(function(){var d=document.createElement('div');d.id='banner';d.setAttribute('role','dialog');d.style.cssText='position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1rem';d.innerHTML='<p>Wir verwenden Cookies.</p><button id="rej">Alle ablehnen</button><button id="acc">Alle akzeptieren</button>';document.body.appendChild(d);d.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){d.remove();});});},1500);</script>`));
      case "/lazy-frame-no-banner":
        // A lazily loaded iframe far below the fold never loads during the scan: it has no document and never answers.
        return html(200, page(`<h1>Lazy</h1><div style="height:6000px"></div><iframe loading="lazy" src="${thirdOrigin}/embed-frame" title="map"></iframe>${FOOTER}`));
      case "/fixed-shell-form":
        // An app shell: the whole page sits in a fixed scroll container without <main>. Its form button is no consent control.
        return html(200, page(`<div id="app" style="position:fixed;inset:0;overflow:auto"><h1>Angebot anfordern</h1><form><input type="email" placeholder="E-Mail"> <button type="submit">Zustimmen</button> <button type="button">Ablehnen</button></form>${FOOTER}</div>`));
      case "/video-lightbox":
        // A consent tool's video placeholder shown in a fixed lightbox: not the cookie banner.
        return html(200, page(`<h1>Videos</h1>${FOOTER}<div class="video-consent" style="position:fixed;top:10%;left:20%;width:60%;background:#fff"><p>Mit dem Laden des Videos akzeptieren Sie die Datenschutzerklärung von YouTube.</p><button>Ablehnen</button><button>Akzeptieren</button></div>`));
      case "/banner-long-text":
        // A banner with a long text (vendor purposes spelled out): still the prompt, not the page.
        return html(200, page(`<h1>Long</h1>${FOOTER}<div id="banner" role="dialog" style="position:fixed;bottom:0;left:0;right:0;max-height:50vh;overflow:auto;background:#fff"><p>Wir verwenden Cookies. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen. Wir und unsere Partner verarbeiten Daten, um Inhalte zu personalisieren und die Nutzung zu messen.</p><button id="rej">Alle ablehnen</button><button id="acc">Alle akzeptieren</button></div><script>document.querySelectorAll('#banner button').forEach(function(b){b.addEventListener('click',function(){document.getElementById('banner').remove();});});</script>`));
      case "/newsletter-prompt":
        // A newsletter prompt whose only consent-like words are its own button labels.
        return html(200, page(`<h1>Shop</h1>${FOOTER}<div role="dialog" style="position:fixed;top:0;left:30%;width:40%;background:#fff;padding:1rem"><p>Möchten Sie unseren Newsletter mit neuen Angeboten erhalten?</p><button type="button">Ablehnen</button><button type="button">Zustimmen</button></div>`));
      case "/contact-hidden-captcha":
        // A small contact page with a hidden bot-protection element: an ordinary page, not a bot check.
        return html(200, page(`<h1>Kontakt</h1><p>Schreiben Sie uns.</p><form><input type="email"></form><div id="px-captcha" style="display:none"></div>${FOOTER}`));
      case "/banner-many-links": {
        // A news page: many links whose text passes the cheap pre-filter come before the banner in the DOM.
        const teasers = Array.from({ length: 25 }, (_, i) => `<li><a href="/artikel-${i}">Zustimmung zur Reform ${i}</a></li>`).join("");
        return html(200, page(`<h1>News</h1><ul>${teasers}</ul>${FOOTER}<div id="banner" role="dialog" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1rem"><p>Wir verwenden Cookies.</p><a href="#" id="rej">Alle ablehnen</a> <a href="#" id="acc">Alle akzeptieren</a></div><script>document.querySelectorAll('#banner input, #banner a, #banner button').forEach(function(b){b.addEventListener('click',function(e){e.preventDefault();document.getElementById('banner').remove();});});</script>`));
      }
      case "/scroll-wrapper-mockup":
        // A smooth-scroll site: the whole page sits in a fixed wrapper. The banner mock-up in the content is no overlay.
        return html(200, `<!doctype html><html lang="de"><head><title>Agency</title></head><body><div id="smooth-wrapper" style="position:fixed;inset:0;overflow:auto"><main><h1>Wir bauen Cookie-Banner</h1><div class="demo"><p>Wir verwenden Cookies.</p><button type="button">Alle akzeptieren</button><button type="button">Nur notwendige Cookies</button></div></main>${FOOTER}</div></body></html>`);
      case "/protected": {
        // A password-protected test site (HTTP basic auth, user "test", password "secret").
        const ok = req.headers.authorization === `Basic ${Buffer.from("test:secret").toString("base64")}`;
        if (!ok) return html(401, "<h1>Login</h1>", { "www-authenticate": 'Basic realm="staging"' });
        // The imprint link sits outside the footer, so a finding quotes it; its session token must not show there.
        return html(200, page(`<h1>Staging</h1><p><a href="/impressum?session=abc123">Impressum</a></p><iframe src="${thirdOrigin}/auth-probe" title="widget"></iframe><div style="height:2000px"></div><footer><a href="/datenschutz#top">Datenschutz</a></footer>`));
      }
      case "/overlay-text-not-control":
        // Control-like words as plain text in a cookie overlay: nothing here may be clicked.
        return html(200, page(`<h1>Text only</h1>${FOOTER}<div style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1rem"><p>Wir verwenden Cookies.</p><p>Alle akzeptieren</p><span>Nur notwendige</span></div>`));
      case "/lazy-footer":
        // The footer renders only when scrolled into view (content-visibility), so innerText is empty.
        // The imprint URL does not say "impressum" (seen on a large price-comparison site), so only
        // the link text identifies it.
        return html(200, page(`<h1>Lazy footer</h1><div style="height:6000px"></div><footer style="content-visibility:auto;contain-intrinsic-size:auto 700px"><nav><a href="/legal/agb">Impressum / AGB</a> <a href="/datenschutz">Datenschutz</a></nav></footer>`));
      case "/legal/agb":
        return html(200, page(`<h1>Impressum und AGB</h1>`));
      case "/wall":
        // A first visit is redirected to a separate full-page consent choice (a "consent wall").
        return html(302, "", { location: "/consent-management/" });
      case "/consent-management/":
        return html(200, page(`<h1>Wir finanzieren uns über Werbung</h1><p>Abo ohne Werbung oder mit Werbung und Tracking weiter.</p><a href="/abo">Zum Abo</a> <button type="button">Akzeptieren und weiter</button>`));
      case "/banner-sometimes-late": {
        // The banner of one marked visit stays hidden long enough for the shorter banner wait to miss
        // it, so that visit is repeated and the repeat gets ticket 2 and the banner at once. Only
        // marked visits ask for a ticket: the baseline shows the banner at once, so which visit is
        // delayed never depends on the parallel request order (the binding name is runConsentSession's).
        return html(200, bannerPage("good", thirdOrigin)
          .replace('id="banner" style="', 'id="banner" style="display:none;')
          .replace(
            "</main>",
            `<script>var b=document.getElementById('banner');
              function showBanner(ms){setTimeout(function(){b.style.display='block';},ms);}
              if(typeof window.__consentprobeMark==='function'){fetch('/late-ticket').then(function(r){return r.text();}).then(function(a){showBanner(a==='delay'?3000:0);});}
              else{showBanner(0);}
            </script></main>`,
          ));
      }
      case "/late-ticket":
        // One ticket per scan: the first marked visit (the click visits) gets a late banner, the repeat
        // of the visit that missed it and every later visit get it at once.
        lateTickets += 1;
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(lateTickets === 1 ? "delay" : "later");
      case "/legal-scripted":
        // Page-builder footer: clickable headings whose URL is set by a script, no href anywhere.
        return html(200, page(`<h1>Scripted legal</h1><footer><div class="blurb" style="cursor:pointer" onclick="location.href='/impressum'"><h6 tabindex="-1">Impressum</h6></div><div class="blurb" style="cursor:pointer" onclick="location.href='/datenschutz'"><h6 tabindex="-1">Datenschutz</h6></div></footer>`));
      case "/legal-scripted-at":
        // The same, with the Austrian and Swiss-French wording the link search knows too.
        return html(200, page(`<h1>Scripted legal</h1><footer><div class="blurb" style="cursor:pointer" onclick="location.href='/impressum'"><h6 tabindex="-1">Offenlegung</h6></div><div class="blurb" style="cursor:pointer" onclick="location.href='/datenschutz'"><h6 tabindex="-1">Protection des données</h6></div></footer>`));
      case "/legal-text-only":
        // The words appear, but nothing can be clicked: there is no link.
        return html(200, page(`<h1>Text only</h1><footer><p>Impressum</p><p>Datenschutz</p></footer>`));
      case "/blocked":
        return html(403, page("Da ist etwas schiefgelaufen"));
      case "/impressum":
        return html(200, page(`<h1>/impressum</h1>`));
      case "/datenschutz":
        return html(200, page(`<h1>/datenschutz</h1>`));
      default:
        return html(404, page("not found"));
    }
  });
  const firstPort = await listen(first, "127.0.0.1");

  return {
    origin: `http://localhost:${firstPort}`,
    thirdPartyHost: "127.0.0.1",
    thirdPartySawCredentials: () => thirdPartyAuthorization,
    lateTicketCount: () => lateTickets,
    resetLateTickets: () => {
      lateTickets = 0;
    },
    close: () =>
      new Promise((resolve) => {
        first.close(() => third.close(() => resolve()));
        first.closeAllConnections();
        third.closeAllConnections();
      }),
  };
}

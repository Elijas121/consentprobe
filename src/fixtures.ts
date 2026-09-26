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
  close: () => Promise<void>;
}

export async function startFixtures(): Promise<Fixtures> {
  const third = createServer((req, res) => {
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

  let lateVisits = 0;
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
      case "/banner-many-links": {
        // A news page: many links whose text passes the cheap pre-filter come before the banner in the DOM.
        const teasers = Array.from({ length: 25 }, (_, i) => `<li><a href="/artikel-${i}">Zustimmung zur Reform ${i}</a></li>`).join("");
        return html(200, page(`<h1>News</h1><ul>${teasers}</ul>${FOOTER}<div id="banner" role="dialog" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1rem"><p>Wir verwenden Cookies.</p><a href="#" id="rej">Alle ablehnen</a> <a href="#" id="acc">Alle akzeptieren</a></div><script>document.querySelectorAll('#banner input, #banner a, #banner button').forEach(function(b){b.addEventListener('click',function(e){e.preventDefault();document.getElementById('banner').remove();});});</script>`));
      }
      case "/scroll-wrapper-mockup":
        // A smooth-scroll site: the whole page sits in a fixed wrapper. The banner mock-up in the content is no overlay.
        return html(200, `<!doctype html><html lang="de"><head><title>Agency</title></head><body><div id="smooth-wrapper" style="position:fixed;inset:0;overflow:auto"><main><h1>Wir bauen Cookie-Banner</h1><div class="demo"><p>Wir verwenden Cookies.</p><button type="button">Alle akzeptieren</button><button type="button">Nur notwendige Cookies</button></div></main>${FOOTER}</div></body></html>`);
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
        // Every second visit shows the banner only after 1.5 s: parallel visits can disagree.
        lateVisits += 1;
        const delay = lateVisits % 2 === 0 ? 1500 : 0;
        return html(200, bannerPage("good", thirdOrigin)
          .replace('id="banner" style="', 'id="banner" style="display:none;')
          .replace("</main>", `<script>setTimeout(function(){document.getElementById('banner').style.display='block';},${delay});</script></main>`));
      }
      case "/legal-scripted":
        // Page-builder footer: clickable headings whose URL is set by a script, no href anywhere.
        return html(200, page(`<h1>Scripted legal</h1><footer><div class="blurb" style="cursor:pointer" onclick="location.href='/impressum'"><h6 tabindex="-1">Impressum</h6></div><div class="blurb" style="cursor:pointer" onclick="location.href='/datenschutz'"><h6 tabindex="-1">Datenschutz</h6></div></footer>`));
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
    close: () =>
      new Promise((resolve) => {
        first.close(() => third.close(() => resolve()));
        first.closeAllConnections();
        third.closeAllConnections();
      }),
  };
}

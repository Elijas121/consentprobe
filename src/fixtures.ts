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
      case "/banner-bad":
      case "/banner-no-reject":
      case "/banner-delayed":
      case "/banner-borlabs-style":
      case "/banner-text-link-reject":
      case "/banner-consent-mode":
      case "/banner-kept-cookie":
        return html(200, bannerPage(path.slice("/banner-".length) as BannerKind, thirdOrigin));
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

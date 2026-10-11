"""Browser test for web/ with the live APIs replaced by synthetic responses shaped like
Open-Meteo and Overpass. Test-only: the shipped app never uses this data.

    pip install playwright && python tests/browser_check.py [screenshot_dir]
"""
import re
import os
import sys
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))
from fakeapi import aq_response, overpass_response, wx_response  # noqa: E402


def handler(route):
    url = route.request.url
    u = urlparse(url)
    if "air-quality-api.open-meteo.com" in url:
        return route.fulfill(json=aq_response(parse_qs(u.query)))
    if "api.open-meteo.com" in url:
        return route.fulfill(json=wx_response(parse_qs(u.query)))
    if "interpreter" in url:
        body = parse_qs(route.request.post_data)["data"][0]
        m = re.search(r"around:\d+,([-\d.]+),([-\d.]+)", body)
        return route.fulfill(json=overpass_response(float(m.group(1)), float(m.group(2))))
    return route.abort()


def main(out_dir):
    errs = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        for scheme, size in (("light", (1280, 900)), ("dark", (400, 860))):
            ctx = b.new_context(viewport={"width": size[0], "height": size[1]}, color_scheme=scheme)
            ctx.route(re.compile(r"^https?://"), handler)
            pg = ctx.new_page()
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.goto(f"file://{ROOT}/index.html#world"); pg.wait_for_selector("#worldMap path.country"); pg.wait_for_timeout(300)
            assert pg.locator("#worldMap path.country").count() > 200
            assert "capital cities" in pg.inner_text(".lead")
            if out_dir: pg.screenshot(path=f"{out_dir}/world-{scheme}.png", full_page=True)
            pg.goto(f"file://{ROOT}/index.html#IN"); pg.wait_for_selector("#cMap circle.pt"); pg.wait_for_timeout(200)
            if out_dir: pg.screenshot(path=f"{out_dir}/country-{scheme}.png", full_page=True)
            pg.click(".row[data-go]"); pg.wait_for_selector("#chart path"); pg.wait_for_selector("#siteMap", timeout=5000); pg.wait_for_timeout(300)
            txt = pg.inner_text("#view")
            assert "Detect" in txt and "Likely cause" in txt and "Schools" in txt
            if pg.locator("[data-done]").count():
                pg.locator("[data-done]").first.check(); pg.wait_for_timeout(100)
            if out_dir: pg.screenshot(path=f"{out_dir}/city-{scheme}.png", full_page=True)
            sw = pg.evaluate("document.documentElement.scrollWidth")
            assert sw <= size[0], f"horizontal scroll {sw}"
            pg.fill("#q", "chen"); pg.wait_for_timeout(100)
            assert pg.locator("#qres button").count() > 0
            ctx.close()
        # offline: everything fails -> banner, not a crash
        ctx = b.new_context(); ctx.route(re.compile(r"^https?://"), lambda r: r.abort()); pg = ctx.new_page()
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"file://{ROOT}/index.html#world"); pg.wait_for_selector("#banner:not([hidden])", timeout=15000)
        assert "could not load" in pg.inner_text("#banner")
        b.close()
    assert not errs, errs
    print("browser check passed")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)

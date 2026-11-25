# Starts the real Electron app under a virtual display and drives it over the DevTools protocol.
import asyncio, subprocess, time, json, os, signal
from playwright.async_api import async_playwright
async def main():
    env = dict(os.environ, ELECTRON_DISABLE_SANDBOX='1')
    proc = subprocess.Popen(['xvfb-run', '-a', '-s', '-screen 0 1600x1000x24', 'node_modules/electron/dist/electron', '.', '--no-sandbox', '--remote-debugging-port=9333'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, preexec_fn=os.setsid)
    try:
        async with async_playwright() as p:
            br = None
            for _ in range(60):
                try: br = await p.chromium.connect_over_cdp('http://127.0.0.1:9333'); break
                except Exception: time.sleep(0.5)
            pg = None
            for _ in range(40):
                pages = [pg for c in br.contexts for pg in c.pages]
                if pages: pg = pages[0]; break
                await asyncio.sleep(0.25)
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            await pg.wait_for_selector('#welcomeDemo'); await pg.wait_for_timeout(500)
            out = {}
            out['native'] = await pg.evaluate('!!window.kilnNative && window.kilnNative.platform')
            out['title0'] = await pg.title()
            await pg.click('#welcomeDemo'); await pg.wait_for_timeout(300)
            for proc_id in ['ws.repeat', 'spec.hold', 'gr.brassage', 'fx.chain']:
                await pg.evaluate(f'() => {{ const S = window.__kiln.S; S.proc = "{proc_id}"; S.inA = S.sounds[0].id; S.autoplay = true; window.__kiln.selectSound(S.sounds[0].id); }}')
                n0 = await pg.evaluate('window.__kiln.S.sounds.length')
                await pg.keyboard.press('Control+Enter')
                for _ in range(200):
                    if await pg.evaluate(f'window.__kiln.S.sounds.length > {n0} && !window.__kiln.S.busy'): break
                    await asyncio.sleep(0.1)
            out['sounds'] = await pg.evaluate('window.__kiln.S.sounds.map(s => s.name + " " + (s.ch[0].length/s.sr).toFixed(2) + "s")')
            out['playing'] = await pg.evaluate('window.__kiln.player.playing')
            out['title'] = await pg.title()
            await pg.screenshot(path='/tmp/k_electron.png')
            print(json.dumps(out, indent=1)); print('errors:', errs or 'none')
            await br.close()
    finally:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
asyncio.run(main())

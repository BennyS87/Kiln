import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'file:///home/claude/kiln/src/index.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required','--no-sandbox'])
        ctx = await b.new_context(viewport={'width':1500,'height':940}, bypass_csp=True); pg = await ctx.new_page()
        errs=[]
        pg.on('console', lambda m: errs.append(m.text) if m.type in ('error','warning') else None)
        pg.on('pageerror', lambda e: errs.append('PAGEERROR '+str(e)))
        await pg.goto(URL); await pg.wait_for_timeout(500)
        await pg.screenshot(path='/tmp/k0.png')
        await pg.click('#welcomeDemo'); await pg.wait_for_timeout(400)
        # choose a process and render
        await pg.fill('#procSearch','stretch'); await pg.wait_for_timeout(100)
        await pg.click('#procList .proc >> nth=0'); await pg.wait_for_timeout(200)
        await pg.click('#renderBtn')
        await pg.wait_for_function('window.__kiln.S.sounds.length >= 2 && !window.__kiln.S.busy', timeout=60000)
        await pg.wait_for_timeout(600)
        await pg.screenshot(path='/tmp/k1.png')
        info = await pg.evaluate('''() => { const S = window.__kiln.S; return S.sounds.map(s => ({name: s.name, dur: (s.ch[0].length/s.sr).toFixed(2), ch: s.ch.length, step: s.step && s.step.proc})); }''')
        print(json.dumps(info, indent=1))
        print('\n'.join(errs) or 'no console errors')
        await b.close()
asyncio.run(main())

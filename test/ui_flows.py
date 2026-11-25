import asyncio, json, struct, math, base64
from playwright.async_api import async_playwright
URL = 'file:///home/claude/kiln/src/index.html'

def aiff_bytes(sr=48000, dur=1.0):
    n=int(sr*dur); data=b''.join(struct.pack('>h', int(12000*math.sin(2*math.pi*330*i/sr))) for i in range(n))
    # 80-bit extended sample rate
    def ext(v):
        e=16383+int(math.floor(math.log2(v))); m=int(v*2**(63-(e-16383)))
        return struct.pack('>HQ', e, m)
    comm=struct.pack('>hIh',1,n,16)+ext(sr)
    ssnd=struct.pack('>II',0,0)+data
    body=b'AIFF'+b'COMM'+struct.pack('>I',len(comm))+comm+b'SSND'+struct.pack('>I',len(ssnd))+ssnd
    return b'FORM'+struct.pack('>I',len(body))+body

def wav24(sr=96000, dur=0.5):
    n=int(sr*dur); frames=b''
    for i in range(n):
        for c in range(2):
            v=int(0.5*8388607*math.sin(2*math.pi*(440 if c==0 else 660)*i/sr)); frames+=struct.pack('<i',v)[:3]
    fmt=struct.pack('<HHIIHH',1,2,sr,sr*6,6,24)
    return b'RIFF'+struct.pack('<I',36+len(frames))+b'WAVE'+b'fmt '+struct.pack('<I',16)+fmt+b'data'+struct.pack('<I',len(frames))+frames

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required','--no-sandbox'])
        ctx = await b.new_context(viewport={'width':1500,'height':940}, bypass_csp=True, accept_downloads=True)
        pg = await ctx.new_page()
        errs=[]
        pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
        pg.on('pageerror', lambda e: errs.append('PAGEERROR '+str(e)))
        await pg.goto(URL); await pg.wait_for_timeout(400)
        K='window.__kiln'
        res = {}
        # --- imports: AIFF (48k mono) and 24-bit WAV (96k stereo)
        files=[{'name':'tone.aiff','b64':base64.b64encode(aiff_bytes()).decode()},{'name':'hi.wav','b64':base64.b64encode(wav24()).decode()}]
        await pg.evaluate('''async (files) => { await window.__kiln.importFiles(files.map(f => ({name: f.name, data: Uint8Array.from(atob(f.b64), c => c.charCodeAt(0))}))); }''', files)
        await pg.wait_for_timeout(300)
        res['imports'] = await pg.evaluate(f'''() => {K}.S.sounds.map(s => [s.name, s.sr, s.ch.length, +(s.ch[0].length/s.sr).toFixed(3), +Math.max(...s.ch[0].slice(0,4000)).toFixed(3)])''')
        # --- demo sound for the process sweep, 3 s to keep it quick
        await pg.evaluate(f'''() => {{ {K}.demoSound(); const S={K}.S; const s=S.sounds[S.sounds.length-1]; s.ch = s.ch.map(c => c.slice(0, s.sr*3)); s._v++; {K}.selectSound(s.id); }}''')
        demo = await pg.evaluate(f'{K}.S.view')
        b_id = await pg.evaluate(f'{K}.S.sounds[1].id')
        # --- every process through the worker
        procs = await pg.evaluate('Object.keys(window.Kiln.DSP.procs).concat(["fx.chain"])')
        sweep=[]
        for pid in procs:
            await pg.evaluate(f'''() => {{ const S={K}.S; S.inA = "{demo}"; S.inB = "{b_id}"; S.proc = "{pid}"; S.autoplay=false; S.replace=false;
                const v = S.vals["{pid}"] = window.Kiln.DSP.procs["{pid}"] ? window.Kiln.DSP.defaults(window.Kiln.DSP.procs["{pid}"], 3) : {{tail:1.5,bpm:120,gain:0}};
                for (const k of ["dur","hold"]) if (typeof v[k] === "number") v[k] = Math.min(v[k], 4);
                {K}.selectSound("{demo}"); }}''')
            n0 = await pg.evaluate(f'{K}.S.sounds.length')
            await pg.click('#renderBtn')
            try:
                await pg.wait_for_function(f'{K}.S.sounds.length > {n0} && !{K}.S.busy', timeout=60000)
                r = await pg.evaluate(f'''() => {{ const s={K}.S.sounds.find(x=>x.id==={K}.S.view); let pk=0, bad=false; for (const c of s.ch) for (const v of c) {{ if(!isFinite(v)) bad=true; const a=Math.abs(v); if(a>pk) pk=a; }} return [s.step.proc, s.ch.length, +(s.ch[0].length/s.sr).toFixed(2), +pk.toFixed(3), bad]; }}''')
            except Exception as e:
                r = [pid, 'FAILED', str(e)[:80], await pg.evaluate(f'document.querySelector(".pp-foot .status").textContent')]
            sweep.append(r)
        res['sweep_bad'] = [r for r in sweep if len(r)<5 or r[4] or r[3] < 0.5 or r[2] < 0.05]
        res['sweep_count'] = len(sweep)
        res['fx'] = [r for r in sweep if r[0]=='fx.chain']
        # --- curve on a parameter, via the UI
        await pg.evaluate(f'''() => {{ const S={K}.S; S.proc="gr.brassage"; S.vals["gr.brassage"]=null; delete S.vals["gr.brassage"]; {K}.selectSound("{demo}"); }}''')
        btns = await pg.query_selector_all('.pk .curve')
        await btns[3].click()   # pitch
        await pg.wait_for_timeout(200)
        await pg.click('.lane-tools button[title="Rise and fall"]')
        lane = await pg.evaluate(f'JSON.stringify({K}.S.vals["gr.brassage"].pitch)')
        res['lane'] = lane
        # draw a point by clicking the lane canvas
        box = await (await pg.query_selector('.lane canvas')).bounding_box()
        await pg.mouse.click(box['x']+box['width']*0.25, box['y']+box['height']*0.2)
        res['lane_points'] = await pg.evaluate(f'{K}.S.vals["gr.brassage"].pitch.bp.length')
        await pg.screenshot(path='/tmp/k_lane.png')
        # --- crop and history
        await pg.evaluate(f'''() => {{ {K}.selectSound("{demo}"); const v={K}.view(); v.sel=[0.5,1.5]; {K}.command("crop"); }}''')
        res['crop'] = await pg.evaluate(f'''() => {{ const s={K}.S.sounds.find(x=>x.id==={K}.S.view); return [s.name, +(s.ch[0].length/s.sr).toFixed(3), s.step.proc]; }}''')
        # --- chain two processes then save a recipe through the dialog
        await pg.evaluate(f'''() => {{ const S={K}.S; S.proc="ws.repeat"; S.inA=S.view; }}''')
        n0 = await pg.evaluate(f'{K}.S.sounds.length'); await pg.click('#renderBtn'); await pg.wait_for_function(f'{K}.S.sounds.length > {n0} && !{K}.S.busy')
        await pg.evaluate(f'''() => {{ const S={K}.S; {K}.command("chain"); S.proc="spec.blur"; }}''')
        n0 = await pg.evaluate(f'{K}.S.sounds.length'); await pg.click('#renderBtn'); await pg.wait_for_function(f'{K}.S.sounds.length > {n0} && !{K}.S.busy')
        res['history_steps'] = await pg.evaluate('document.querySelectorAll("#history .hist-step").length')
        await pg.click('#recipeBtn'); await pg.fill('#rcpName','Grit blur'); await pg.click('#rcpOk')
        await pg.click('.recipe button'); await pg.wait_for_timeout(200)
        # tick the demo sound and the aiff
        await pg.evaluate(f'''() => {{ document.querySelectorAll('.modal input[type=checkbox]').forEach(c => c.checked = (c.value === "{demo}" || c.value === {K}.S.sounds[0].id)); }}''')
        n0 = await pg.evaluate(f'{K}.S.sounds.length')
        await pg.click('#apOk'); await pg.wait_for_function(f'{K}.S.sounds.length >= {n0}+2', timeout=60000)
        res['recipe'] = await pg.evaluate(f'''() => {{ const S={K}.S; return S.sounds.filter(s => s.step && s.step.proc==="recipe").map(s => [s.name, +(s.ch[0].length/s.sr).toFixed(2)]); }}''')
        # --- undo / redo
        a = await pg.evaluate(f'{K}.S.sounds.length'); await pg.evaluate(f'{K}.command("undo")'); u = await pg.evaluate(f'{K}.S.sounds.length'); await pg.evaluate(f'{K}.command("redo")'); r_ = await pg.evaluate(f'{K}.S.sounds.length')
        res['undo'] = [a,u,r_]
        # --- project round trip
        res['roundtrip'] = await pg.evaluate(f'''() => {{ const k={K}; const before = k.S.sounds.map(s => [s.name, s.ch[0].length, s.ch[0][1234]]); const txt = k.serialise(); k.load(txt, null); const after = k.S.sounds.map(s => [s.name, s.ch[0].length, s.ch[0][1234]]); return [txt.length, JSON.stringify(before)===JSON.stringify(after), k.S.recipes.length]; }}''')
        # --- wav encode/decode round trip at 24 and 32 bit
        res['wav'] = await pg.evaluate(f'''() => {{ const s={K}.S.sounds[2]; const out=[]; for (const bits of [16,24,32]) {{ const b = window.Kiln.Audio.encodeWav(s, bits); const r = window.Kiln.Audio.parseWav(b); let e=0; for (let i=0;i<s.ch[0].length;i++) e=Math.max(e, Math.abs(r.ch[0][i]-Math.max(-1,Math.min(1,s.ch[0][i])))); out.push([bits, r.sr, r.ch.length, e.toExponential(1)]); }} return out; }}''')
        # --- views
        await pg.evaluate(f'''() => {{ {K}.selectSound("{demo}"); }}''')
        await pg.click('#viewSeg button[data-v=both]'); await pg.wait_for_timeout(1500)
        await pg.evaluate(f'''() => {{ const S={K}.S; S.proc="spec.morph"; delete S.vals["spec.morph"]; S.inB="{b_id}"; {K}.selectSound("{demo}"); }}''')
        await pg.wait_for_timeout(500)
        await pg.screenshot(path='/tmp/k_both.png')
        await pg.evaluate(f'''() => {{ const S={K}.S; S.proc="fx.chain"; {K}.selectSound("{demo}"); }}''')
        await pg.wait_for_timeout(300)
        await pg.screenshot(path='/tmp/k_fx.png')
        print(json.dumps(res, indent=1))
        print('errors:', errs or 'none')
        await b.close()
asyncio.run(main())

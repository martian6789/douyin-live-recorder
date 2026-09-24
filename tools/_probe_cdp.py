# -*- coding: utf-8 -*-
# CDP 验证：在真实抖音页面环境里发搜索请求（让抖音自己的 JS 签名）
import json, io, subprocess, time, urllib.request, urllib.parse
import websocket

BASE = r'C:/Users/Administrator/live-review'
OUT = BASE + '/dist/_probe_cdp.txt'
cookie = json.load(io.open(BASE + '/dist/LiveReview-Data/credentials.json', encoding='utf-8'))['douyin']['cookie']
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
PROFILE = r'C:/Users/Administrator/live-review/dist/_cdp_profile'
PORT = 9333

lines = []
proc = subprocess.Popen([
    CHROME, '--headless=new', '--remote-debugging-port=%d' % PORT,
    '--user-data-dir=' + PROFILE, '--window-size=1400,900',
    '--no-first-run', '--disable-gpu', '--remote-allow-origins=*', 'about:blank',
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    # 等 devtools ready
    ver = None
    for _ in range(40):
        try:
            ver = json.load(urllib.request.urlopen('http://127.0.0.1:%d/json/version' % PORT, timeout=2))
            break
        except Exception:
            time.sleep(0.5)
    lines.append('devtools: %s' % bool(ver))

    tabs = json.load(urllib.request.urlopen('http://127.0.0.1:%d/json' % PORT, timeout=5))
    page = next(t for t in tabs if t['type'] == 'page')
    ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=30)
    mid = [0]

    def cmd(method, params=None):
        mid[0] += 1
        i = mid[0]
        ws.send(json.dumps({'id': i, 'method': method, 'params': params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get('id') == i:
                return msg.get('result', msg)

    def js(expr, await_promise=True):
        r = cmd('Runtime.evaluate', {
            'expression': expr, 'awaitPromise': await_promise,
            'returnByValue': True, 'timeout': 25000,
        })
        res = r.get('result', {})
        if 'exceptionDetails' in r:
            return {'__exc': json.dumps(r['exceptionDetails'])[:300]}
        return res.get('value')

    # 1. 写入 Cookie（先导航到 douyin 域才有 cookie 上下文）
    cmd('Page.enable')
    cmd('Page.navigate', {'url': 'https://www.douyin.com/'})
    time.sleep(6)
    pairs = []
    for part in cookie.split(';'):
        part = part.strip()
        if '=' in part:
            k, v = part.split('=', 1)
            pairs.append({'name': k, 'value': v, 'domain': '.douyin.com', 'path': '/'})
    r = cmd('Network.setCookies', {'cookies': pairs})
    lines.append('setCookies: %s' % json.dumps(r)[:120])

    # 重新加载让 cookie 生效
    cmd('Page.navigate', {'url': 'https://www.douyin.com/?recommend=1'})
    time.sleep(8)
    lines.append('page title: %s' % js('document.title'))

    # 2. 在页面上下文里发搜索请求（抖音 hook 了 fetch，会自动加签名）
    kw = 'qjandu17177'
    expr = """
    (async () => {
      const qs = new URLSearchParams({
        device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
        search_channel: 'aweme_user_web', enable_history: '1',
        keyword: %r, search_source: 'normal_search', query_correct_type: '1',
        is_filter_search: '0', offset: '0', count: '12',
        version_code: '170400', version_name: '17.4.0',
        cookie_enabled: 'true', platform: 'PC', downlink: '10'
      });
      const res = await fetch('https://www.douyin.com/aweme/v1/web/general/search/single/?' + qs.toString(), {
        credentials: 'include'
      });
      const text = await res.text();
      return text.slice(0, 20000);
    })()
    """ % kw
    raw = js(expr)
    if isinstance(raw, str) and not raw.startswith('{'):
        lines.append('non-json resp: %s' % raw[:200])
    else:
        try:
            j = json.loads(raw)
            users = []
            def walk(n):
                if isinstance(n, list):
                    for x in n: walk(x)
                elif isinstance(n, dict):
                    sec = n.get('sec_uid'); nick = n.get('nickname')
                    if isinstance(sec, str) and sec and isinstance(nick, str) and nick:
                        users.append({
                            'nick': nick,
                            'uid': n.get('unique_id') or n.get('short_id') or '',
                            'living': n.get('live_status'),
                            'room': n.get('room_id') or n.get('web_rid'),
                        })
                    for v in n.values(): walk(v)
            walk(j)
            seen, dd = set(), []
            for u in users:
                if u['nick'] not in seen or u['uid']:
                    if (u['nick'], u['uid']) not in seen:
                        seen.add((u['nick'], u['uid'])); dd.append(u)
            lines.append('status_code=%s users=%d' % (j.get('status_code'), len(dd)))
            for u in dd[:8]:
                lines.append('  ' + json.dumps(u, ensure_ascii=False))
        except Exception as e:
            lines.append('parse exc: %s / raw head: %s' % (e, str(raw)[:200]))
finally:
    try: proc.kill()
    except Exception: pass

io.open(OUT, 'w', encoding='utf-8').write('\n'.join(lines))
print('done')

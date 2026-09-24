# -*- coding: utf-8 -*-
# 探测：抖音搜索接口对「抖音号」关键词的返回
import json, io, urllib.request, urllib.parse, gzip, re, sys

BASE = r'C:/Users/Administrator/live-review'
OUT = BASE + '/dist/_probe_s.txt'

def load_cookie():
    p = BASE + '/dist/LiveReview-Data/credentials.json'
    try:
        d = json.load(io.open(p, encoding='utf-8'))
        c = d.get('douyin', {}).get('cookie') or ''
        return c if c else None
    except Exception as e:
        return None

cookie = load_cookie()
lines = []
lines.append('cookie loaded: %s (len=%s)' % (bool(cookie), len(cookie) if cookie else 0))

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

def call(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Referer': 'https://www.douyin.com/',
        'Cookie': cookie or '',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip',
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        data = r.read()
        if r.headers.get('Content-Encoding') == 'gzip':
            data = gzip.decompress(data)
    return json.loads(data.decode('utf-8', 'replace'))

def search(keyword, extra=None):
    qs = {
        'device_platform': 'webapp', 'aid': '6383', 'channel': 'channel_pc_web',
        'search_channel': 'aweme_user_web', 'enable_history': '1',
        'keyword': keyword, 'search_source': 'normal_search',
        'query_correct_type': '1', 'is_filter_search': '0',
        'offset': '0', 'count': '12', 'version_code': '170400',
        'version_name': '17.4.0', 'cookie_enabled': 'true', 'platform': 'PC', 'downlink': '10',
    }
    if extra: qs.update(extra)
    url = 'https://www.douyin.com/aweme/v1/web/general/search/single/?' + urllib.parse.urlencode(qs)
    try:
        j = call(url)
    except Exception as e:
        return {'EXC': str(e)}
    sc = j.get('status_code')
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
                    'sec': sec[:14] + '...',
                })
            for v in n.values(): walk(v)
    walk(j)
    # 去重
    seen, dd = set(), []
    for u in users:
        if u['sec'] not in seen:
            seen.add(u['sec']); dd.append(u)
    return {'status_code': sc, 'n': len(dd), 'users': dd[:6]}

kw = 'qjandu17177'
lines.append('=== A. 原样参数搜抖音号 ===')
lines.append(json.dumps(search(kw), ensure_ascii=False, indent=1))

lines.append('=== B. is_filter_search=1 (精确用户筛选) ===')
lines.append(json.dumps(search(kw, {'is_filter_search': '1'}), ensure_ascii=False, indent=1))

lines.append('=== C. search_channel 去掉(全量) ===')
lines.append(json.dumps(search(kw, {'search_channel': ''}), ensure_ascii=False, indent=1))

io.open(OUT, 'w', encoding='utf-8').write('\n'.join(lines))
print('done')

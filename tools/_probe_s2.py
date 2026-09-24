# -*- coding: utf-8 -*-
# 探测2：同接口搜昵称是否还有数据；以及 aa.sso/im 等替代通道
import json, io, urllib.request, urllib.parse, gzip

BASE = r'C:/Users/Administrator/live-review'
OUT = BASE + '/dist/_probe_s2.txt'
cookie = json.load(io.open(BASE + '/dist/LiveReview-Data/credentials.json', encoding='utf-8'))['douyin']['cookie']
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

def call(url, referer='https://www.douyin.com/'):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': referer, 'Cookie': cookie,
        'Accept': 'application/json, text/plain, */*', 'Accept-Encoding': 'gzip',
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        data = r.read()
        if r.headers.get('Content-Encoding') == 'gzip':
            data = gzip.decompress(data)
    return json.loads(data.decode('utf-8', 'replace'))

lines = []

def search(keyword):
    qs = {
        'device_platform': 'webapp', 'aid': '6383', 'channel': 'channel_pc_web',
        'search_channel': 'aweme_user_web', 'enable_history': '1',
        'keyword': keyword, 'search_source': 'normal_search',
        'query_correct_type': '1', 'is_filter_search': '0',
        'offset': '0', 'count': '12', 'version_code': '170400',
        'version_name': '17.4.0', 'cookie_enabled': 'true', 'platform': 'PC', 'downlink': '10',
    }
    url = 'https://www.douyin.com/aweme/v1/web/general/search/single/?' + urllib.parse.urlencode(qs)
    try:
        j = call(url)
    except Exception as e:
        return {'EXC': str(e)[:120]}
    users = []
    def walk(n):
        if isinstance(n, list):
            for x in n: walk(x)
        elif isinstance(n, dict):
            sec = n.get('sec_uid'); nick = n.get('nickname')
            if isinstance(sec, str) and sec and isinstance(nick, str) and nick:
                users.append((nick, (n.get('unique_id') or ''), sec[:12]))
            for v in n.values(): walk(v)
    walk(j)
    seen, dd = set(), []
    for u in users:
        if u[2] not in seen: seen.add(u[2]); dd.append(u)
    return {'sc': j.get('status_code'), 'n': len(dd), 'top': dd[:5]}

lines.append('=== 搜昵称「老飘讲故事」===')
lines.append(json.dumps(search('老飘讲故事'), ensure_ascii=False))
lines.append('=== 搜抖音号 qjandu17177 ===')
lines.append(json.dumps(search('qjandu17177'), ensure_ascii=False))

io.open(OUT, 'w', encoding='utf-8').write('\n'.join(lines))
print('done')

# -*- coding: utf-8 -*-
# 探测3：替代通道 —— iesdouyin 老搜索接口 / unique_id 直开主页重定向
import json, io, urllib.request, urllib.parse, gzip

BASE = r'C:/Users/Administrator/live-review'
OUT = BASE + '/dist/_probe_s3.txt'
cookie = json.load(io.open(BASE + '/dist/LiveReview-Data/credentials.json', encoding='utf-8'))['douyin']['cookie']
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
lines = []

def call(url, referer='https://www.douyin.com/'):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': referer, 'Cookie': cookie,
        'Accept': 'application/json, text/plain, */*', 'Accept-Encoding': 'gzip',
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        data = r.read()
        if r.headers.get('Content-Encoding') == 'gzip':
            data = gzip.decompress(data)
        return r.geturl(), data

lines.append('=== A. iesdouyin 老搜索(用户) ===')
try:
    qs = urllib.parse.urlencode({'keyword': 'qjandu17177', 'count': '10', 'offset': '0'})
    final, data = call('https://www.iesdouyin.com/web/api/v2/search/user/?' + qs)
    txt = data.decode('utf-8', 'replace')
    lines.append('final url: ' + final)
    lines.append('len=%d head=%s' % (len(txt), txt[:300]))
except Exception as e:
    lines.append('EXC: %s' % str(e)[:200])

lines.append('=== B. /user/<unique_id> 是否可用 ===')
try:
    final, data = call('https://www.douyin.com/user/qjandu17177')
    txt = data.decode('utf-8', 'replace')
    lines.append('final url: ' + final)
    lines.append('len=%d hasSecUid=%s hasMS4w=%s' % (len(txt), 'sec_uid' in txt, 'MS4wLj' in txt))
    m = __import__('re').search(r'MS4wLj[A-Za-z0-9_-]{8,}', txt)
    if m: lines.append('sec_uid found: ' + m.group(0)[:40])
except Exception as e:
    lines.append('EXC: %s' % str(e)[:200])

lines.append('=== C. iesdouyin 全量搜索(综合) ===')
try:
    qs = urllib.parse.urlencode({'keyword': 'qjandu17177', 'count': '10', 'offset': '0', 'search_channel': 'aweme_general'})
    final, data = call('https://www.iesdouyin.com/web/api/v2/search/item/?' + qs)
    txt = data.decode('utf-8', 'replace')
    lines.append('len=%d head=%s' % (len(txt), txt[:200]))
except Exception as e:
    lines.append('EXC: %s' % str(e)[:200])

io.open(OUT, 'w', encoding='utf-8').write('\n'.join(lines))
print('done')

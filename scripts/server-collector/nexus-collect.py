#!/usr/bin/env python3
"""
Collects what the dashboard's Server tab shows, for the whole VPS.

Runs as root from cron once a minute (installed by install.sh). Nexus runs as
sanskarpandit and cannot see other accounts' PM2, Docker, every process or
other databases, so this script gathers them and writes plain JSON that any
account can read. It only reads; it never changes a process.

Output, under /var/lib/nexus-server (mode 755, files 644):
  snapshot.json              the current picture, rewritten every run
  traffic/YYYY-MM-DD.json    requests per site for one IST day (kept 400 days; 640 root:adm)
  history/YYYY-MM-DD.jsonl   a resource sample every 10 minutes (kept 90 days)
  state.json                 where the log reader stopped, and cached slow readings

Traffic comes from /var/log/nginx/traffic.log, a log install.sh adds that
records the site name for every request (the stock access.log does not).
"""
import grp
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

OUT = os.environ.get('NEXUS_SERVER_DIR', '/var/lib/nexus-server')
TRAFFIC_LOG = os.environ.get('NEXUS_TRAFFIC_LOG', '/var/log/nginx/traffic.log')
IST = timezone(timedelta(hours=5, minutes=30))
DU_EVERY = 30 * 60          # disk use per folder is slow; refresh every 30 minutes
DB_EVERY = 10 * 60
HISTORY_EVERY = 10 * 60
TRAFFIC_KEEP_DAYS = 400
HISTORY_KEEP_DAYS = 90
# Latency buckets in ms, for an approximate p95 without keeping every value.
LAT_EDGES = [10, 25, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000]


def run(cmd, timeout=20, partial=False):
    """partial: keep the output even if the command failed (du exits 1 when one folder is unreadable)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 or partial else ''
    except Exception:
        return ''


def write_json(path, data, private=False):
    """private: root and the adm group only (traffic files hold visitor IPs; sanskarpandit is in adm)."""
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    if private:
        os.chown(tmp, 0, grp.getgrnam('adm').gr_gid)
    os.chmod(tmp, 0o640 if private else 0o644)
    os.replace(tmp, path)


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


# ---------------------------------------------------------------- system

def system():
    mem = {}
    for line in open('/proc/meminfo'):
        k, v = line.split(':', 1)
        mem[k] = int(v.split()[0]) * 1024
    load = open('/proc/loadavg').read().split()[:3]
    st = os.statvfs('/')
    os_name = ''
    for line in open('/etc/os-release'):
        if line.startswith('PRETTY_NAME='):
            os_name = line.split('=', 1)[1].strip().strip('"')
    cpu = cpu_percent()
    return {
        'hostname': os.uname().nodename,
        'os': os_name,
        'cpus': os.cpu_count(),
        'uptimeSec': int(float(open('/proc/uptime').read().split()[0])),
        'load': [float(x) for x in load],
        'cpuPercent': cpu,
        'memTotal': mem['MemTotal'],
        'memAvailable': mem['MemAvailable'],
        'swapTotal': mem.get('SwapTotal', 0),
        'swapFree': mem.get('SwapFree', 0),
        'diskTotal': st.f_blocks * st.f_frsize,
        'diskFree': st.f_bavail * st.f_frsize,
    }


def cpu_percent():
    def sample():
        f = [int(x) for x in open('/proc/stat').readline().split()[1:]]
        idle = f[3] + f[4]
        return idle, sum(f)
    i1, t1 = sample()
    time.sleep(1)
    i2, t2 = sample()
    return round(100 * (1 - (i2 - i1) / max(t2 - t1, 1)), 1)


# ---------------------------------------------------------------- processes

def processes():
    out = run(['ps', '-eo', 'pid=,ppid=,user:32=,rss=,pcpu=,etimes=,args='])
    procs = []
    for line in out.splitlines():
        parts = line.split(None, 6)
        if len(parts) < 7:
            continue
        pid, ppid, user, rss, pcpu, etimes, args = parts
        procs.append({'pid': int(pid), 'ppid': int(ppid), 'user': user, 'rss': int(rss) * 1024,
                      'cpu': float(pcpu), 'ageSec': int(etimes), 'cmd': args[:300], 'container': container_of(pid)})
    return procs


def container_of(pid):
    """The Docker container a process runs in (first 12 characters of its id), from its cgroup."""
    try:
        m = re.search(r'docker[-/]([0-9a-f]{12})', open(f'/proc/{pid}/cgroup').read())
        return m.group(1) if m else None
    except Exception:
        return None


def pm2_lists():
    """Every account's PM2, read as that account (each has its own daemon)."""
    result = []
    for user in sorted(os.listdir('/home')):
        if not os.path.isdir(f'/home/{user}/.pm2'):
            continue
        out = run(['runuser', '-l', user, '-c', 'pm2 jlist'], timeout=30)
        try:
            items = json.loads(out[out.index('['):]) if '[' in out else []
        except Exception:
            items = []
        for p in items:
            env = p.get('pm2_env', {})
            if p.get('name') == 'pm2-logrotate':
                continue
            result.append({
                'account': user,
                'name': p.get('name'),
                'pid': p.get('pid'),
                'status': env.get('status'),
                'restarts': env.get('restart_time', 0),
                'unstableRestarts': env.get('unstable_restarts', 0),
                'startedAt': env.get('pm_uptime'),
                'memory': p.get('monit', {}).get('memory', 0),
                'cpu': p.get('monit', {}).get('cpu', 0),
                'cwd': env.get('pm_cwd'),
                'port': str(env.get('PORT') or (env.get('env') or {}).get('PORT') or ''),
                'interpreter': env.get('exec_interpreter'),
                'nodeVersion': env.get('node_version'),
            })
    return result


def docker():
    containers = []
    ps = run(['docker', 'ps', '-a', '--format', '{{json .}}'])
    stats = {}
    for line in run(['docker', 'stats', '--no-stream', '--format', '{{json .}}'], timeout=40).splitlines():
        try:
            s = json.loads(line)
            stats[s['Name']] = s
        except Exception:
            pass
    for line in ps.splitlines():
        try:
            c = json.loads(line)
        except Exception:
            continue
        s = stats.get(c['Names'], {})
        containers.append({
            'id': c.get('ID', '')[:12], 'name': c['Names'], 'image': c['Image'], 'state': c.get('State'), 'status': c.get('Status'),
            'ports': c.get('Ports', ''), 'cpu': pct(s.get('CPUPerc')), 'memory': size(s.get('MemUsage', '').split('/')[0]),
            'memLimit': size((s.get('MemUsage', '/').split('/') + [''])[1]),
        })
    df = run(['docker', 'system', 'df', '--format', '{{json .}}'])
    images = 0
    for line in df.splitlines():
        try:
            d = json.loads(line)
            if d.get('Type') == 'Images':
                images = size(d.get('Size'))
        except Exception:
            pass
    return containers, images


def pct(v):
    try:
        return float(str(v).strip().rstrip('%'))
    except Exception:
        return 0.0


UNITS = {'b': 1, 'kb': 1e3, 'kib': 1024, 'mb': 1e6, 'mib': 1024 ** 2, 'gb': 1e9, 'gib': 1024 ** 3, 'tb': 1e12, 'tib': 1024 ** 4}


def size(v):
    m = re.match(r'\s*([\d.]+)\s*([a-zA-Z]*)', str(v or ''))
    if not m:
        return 0
    return int(float(m.group(1)) * UNITS.get(m.group(2).lower() or 'b', 1))


def listening_ports():
    """Port → pid, so an app can be matched to the port nginx sends traffic to."""
    out = run(['ss', '-ltnpH'])
    ports = {}
    for line in out.splitlines():
        cols = line.split()
        if len(cols) < 5:
            continue
        port = cols[3].rsplit(':', 1)[-1]
        m = re.search(r'pid=(\d+)', line)
        if m:
            ports.setdefault(port, int(m.group(1)))
    return ports


# ---------------------------------------------------------------- slow readings (cached)

def disk_usage():
    sizes = {}
    for user in os.listdir('/home'):
        out = run(['du', '-sb', '--one-file-system', *[f'/home/{user}/{d}' for d in safe_listdir(f'/home/{user}')]], timeout=300, partial=True)
        for line in out.splitlines():
            b, path = line.split('\t', 1)
            sizes[path] = int(b)
    for path in ['/var/lib/mongodb', '/var/lib/postgresql', '/var/lib/docker', '/var/log']:
        out = run(['du', '-sb', path], timeout=300)
        if out:
            sizes[path] = int(out.split('\t', 1)[0])
    return sizes


def safe_listdir(p):
    try:
        return [d for d in os.listdir(p) if not d.startswith('.')]
    except Exception:
        return []


def databases():
    dbs = []
    out = run(['runuser', '-u', 'postgres', '--', 'psql', '-AtF', '\t', '-c',
               'select datname, pg_database_size(datname) from pg_database where datallowconn and datname not like \'template%\''])
    for line in out.splitlines():
        name, b = line.split('\t')
        dbs.append({'engine': 'postgres', 'name': name, 'bytes': int(b)})
    js = 'JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>[d.name,d.sizeOnDisk]))'
    out = run(['mongosh', '--quiet', '--eval', js]) or run(['mongo', '--quiet', '--eval', js])
    try:
        for name, b in json.loads(out.strip().splitlines()[-1]):
            if name not in ('admin', 'local', 'config'):
                dbs.append({'engine': 'mongodb', 'name': name, 'bytes': int(b)})
    except Exception:
        pass
    return dbs


DB_SCHEMES = ('mongodb', 'mongodb+srv', 'postgres', 'postgresql', 'mysql', 'redis')
LOCAL_HOSTS = ('127.0.0.1', 'localhost', '::1', '[::1]')


def db_endpoints():
    """
    Every database the apps connect to, found in their .env files, with its size.

    Only the scheme, server name(s) and database name are kept: the login is
    split off and dropped before anything is stored. Sizes are read with the
    app's own connection string (so cloud databases such as MongoDB Atlas are
    measured too) and never written anywhere.
    """
    from urllib.parse import urlsplit
    seen, out = {}, []
    files = run(['find', '/home', '-maxdepth', '5', '-name', '.env', '-not', '-path', '*/node_modules/*',
                 '-not', '-path', '*/.git/*', '-not', '-path', '*/backups/*'], timeout=60, partial=True).split()
    for path in files:
        try:
            lines = open(path, encoding='utf-8', errors='replace').read().splitlines()
        except Exception:
            continue
        for line in lines:
            if '=' not in line or line.lstrip().startswith('#'):
                continue
            key, val = line.split('=', 1)
            val = val.strip().strip('"').strip("'")
            scheme = val.split('://', 1)[0].lower() if '://' in val else ''
            if scheme not in DB_SCHEMES:
                continue
            try:
                u = urlsplit(val)
                hosts = u.netloc.rsplit('@', 1)[-1]          # drop user:password
                database = u.path.lstrip('/').split('/')[0]
            except Exception:
                continue
            ident = (scheme, hosts, database)
            entry = {'file': path, 'key': key.strip()[:60], 'scheme': scheme, 'hosts': hosts[:300], 'database': database[:120]}
            if ident not in seen:
                seen[ident] = db_size(scheme, val, database)
            entry.update(seen[ident])
            out.append(entry)
    return out


def db_size(scheme, uri, database):
    """Size in bytes, measured with the app's own connection string. The URI is passed to the tool and nothing else."""
    try:
        if scheme.startswith('mongodb') and database:
            # Number(): Atlas answers with 64-bit Long objects ({low, high}), not plain numbers.
            js = 'const s=db.stats();print(JSON.stringify({d:Number(s.dataSize),s:Number(s.storageSize),i:Number(s.indexSize)}))'
            r = subprocess.run(['mongosh', uri, '--quiet', '--norc', '--eval', js], capture_output=True, text=True, timeout=30)
            s = json.loads(r.stdout.strip().splitlines()[-1])
            return {'bytes': int(s['s'] + s['i']), 'dataBytes': int(s['d'])}
        if scheme.startswith('postgres'):
            r = subprocess.run(['psql', uri.split('?')[0], '-Atc', 'select pg_database_size(current_database())'],
                               capture_output=True, text=True, timeout=30)
            return {'bytes': int(r.stdout.strip())}
    except Exception:
        pass
    return {'bytes': None}


def extra_databases():
    """Databases with no URL in a .env: RestoBill's own Postgres container and Gold Rate's SQLite files."""
    out = []
    q = "select datname, pg_database_size(datname) from pg_database where datname like 'restobill%'"
    for line in run(['docker', 'exec', 'restobill-postgres', 'psql', '-U', 'restobill_admin', '-d', 'postgres', '-AtF', '\t', '-c', q]).splitlines():
        name, b = line.split('\t')
        out.append({'scheme': 'postgresql', 'hosts': 'restobill-postgres (Docker)', 'database': name, 'bytes': int(b), 'docker': True})
    for env in ('prod', 'dev'):
        p = f'/home/sanskarpandit/goldrate/{env}/data/goldrate.db'
        if os.path.exists(p):
            out.append({'scheme': 'sqlite', 'hosts': 'file on VPS', 'database': p, 'bytes': os.path.getsize(p)})
    return out


# ---------------------------------------------------------------- traffic

def lat_bucket(ms):
    for i, edge in enumerate(LAT_EDGES):
        if ms <= edge:
            return i
    return len(LAT_EDGES)


def new_host():
    return {'requests': 0, 'status': {'2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, 'other': 0},
            'bytes': 0, 'latencySumMs': 0, 'latency': [0] * (len(LAT_EDGES) + 1), 'hours': [0] * 24, 'ips': []}


def read_traffic(state):
    """Reads the new part of traffic.log (and the rotated file, if it rotated) into per-IST-day files."""
    pos = state.get('traffic', {})
    try:
        st = os.stat(TRAFFIC_LOG)
    except FileNotFoundError:
        return False
    chunks = []
    if pos.get('inode') and pos['inode'] != st.st_ino:
        # Rotated: finish the old file (now traffic.log.1) where we stopped.
        try:
            if os.stat(TRAFFIC_LOG + '.1').st_ino == pos['inode']:
                chunks.append((TRAFFIC_LOG + '.1', pos.get('offset', 0)))
        except FileNotFoundError:
            pass
        offset = 0
    else:
        offset = pos.get('offset', 0) if pos.get('inode') else 0
        if offset > st.st_size:
            offset = 0
    chunks.append((TRAFFIC_LOG, offset))

    days = {}
    ip_sets = {}
    end = offset
    for path, start in chunks:
        with open(path, 'rb') as f:
            f.seek(start)
            for raw in f:
                if not raw.endswith(b'\n'):
                    break  # half-written line: read it next time
                if path == TRAFFIC_LOG:
                    end = f.tell()
                cols = raw.decode('utf-8', 'replace').rstrip('\n').split('\t')
                if len(cols) < 6:
                    continue
                ts, host, status, rt, ip, sent = cols[:6]
                try:
                    t = datetime.fromisoformat(ts).astimezone(IST)
                except ValueError:
                    continue
                day = t.strftime('%Y-%m-%d')
                if day not in days:
                    days[day] = load_json(f'{OUT}/traffic/{day}.json', {'day': day, 'hosts': {}})
                hosts = days[day]['hosts']
                host = host.lower()[:120] or '-'
                h = hosts.get(host) or new_host()
                hosts[host] = h
                h['requests'] += 1
                cls = status[:1] + 'xx' if status[:1] in '2345' and len(status) == 3 else 'other'
                h['status'][cls] += 1
                try:
                    ms = float(rt) * 1000
                except ValueError:
                    ms = 0
                h['latencySumMs'] += round(ms)
                h['latency'][lat_bucket(ms)] += 1
                h['hours'][t.hour] += 1
                h['bytes'] += int(sent) if sent.isdigit() else 0
                key = (day, host)
                if key not in ip_sets:
                    ip_sets[key] = set(h['ips'])
                ip_sets[key].add(ip)
    for (day, host), ips in ip_sets.items():
        days[day]['hosts'][host]['ips'] = sorted(ips)
    for day, data in days.items():
        data['updatedAt'] = datetime.now(timezone.utc).isoformat()
        write_json(f'{OUT}/traffic/{day}.json', data, private=True)
    state['traffic'] = {'inode': st.st_ino, 'offset': end}
    return True


# ---------------------------------------------------------------- main

def prune(folder, keep_days, suffix):
    cutoff = (datetime.now(IST) - timedelta(days=keep_days)).strftime('%Y-%m-%d')
    for name in safe_listdir(folder):
        if name.endswith(suffix) and name[:10] < cutoff:
            os.remove(os.path.join(folder, name))


def main():
    for d in (OUT, f'{OUT}/traffic', f'{OUT}/history'):
        os.makedirs(d, exist_ok=True)
        os.chmod(d, 0o755)
    state = load_json(f'{OUT}/state.json', {})
    now = time.time()

    if now - state.get('duAt', 0) > DU_EVERY or 'du' not in state:
        state['du'] = disk_usage()
        state['duAt'] = now
    if now - state.get('dbAt', 0) > DB_EVERY or 'dbEndpoints' not in state:
        state['db'] = databases()
        state['dbEndpoints'] = db_endpoints() + extra_databases()
        state['dbAt'] = now

    traffic_on = read_traffic(state)
    containers, docker_images = docker()
    snap = {
        'version': 1,
        'collectedAt': datetime.now(timezone.utc).isoformat(),
        'system': system(),
        'pm2': pm2_lists(),
        'docker': containers,
        'dockerImagesBytes': docker_images,
        'processes': [p for p in processes() if p['rss'] > 20 * 1024 * 1024],
        'ports': listening_ports(),
        'diskUsage': state['du'],
        'diskUsageAt': datetime.fromtimestamp(state['duAt'], timezone.utc).isoformat(),
        'databases': state['db'],
        'dbEndpoints': state.get('dbEndpoints', []),
        'trafficLog': traffic_on,
    }
    write_json(f'{OUT}/snapshot.json', snap)

    if now - state.get('historyAt', 0) >= HISTORY_EVERY - 30:
        s = snap['system']
        sample = {
            't': snap['collectedAt'],
            'load': s['load'][0], 'cpu': s['cpuPercent'],
            'memUsed': s['memTotal'] - s['memAvailable'], 'diskUsed': s['diskTotal'] - s['diskFree'],
            'pm2': {f"{p['account']}/{p['name']}": p['memory'] for p in snap['pm2']},
            'docker': {c['name']: c['memory'] for c in containers},
            'restarts': {f"{p['account']}/{p['name']}": p['restarts'] for p in snap['pm2']},
        }
        day = datetime.now(IST).strftime('%Y-%m-%d')
        path = f'{OUT}/history/{day}.jsonl'
        with open(path, 'a') as f:
            f.write(json.dumps(sample, separators=(',', ':')) + '\n')
        os.chmod(path, 0o644)
        state['historyAt'] = now
        prune(f'{OUT}/history', HISTORY_KEEP_DAYS, '.jsonl')
        prune(f'{OUT}/traffic', TRAFFIC_KEEP_DAYS, '.json')

    write_json(f'{OUT}/state.json', state)
    os.chmod(f'{OUT}/state.json', 0o600)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # one loud line in the cron log beats a silent gap
        print(f'nexus-collect failed: {e!r}', file=sys.stderr)
        sys.exit(1)

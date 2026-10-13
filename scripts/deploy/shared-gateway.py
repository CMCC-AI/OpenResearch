"""Extend the known CMCC gateway without replacing its existing application routes."""
import datetime,json,pathlib,subprocess


def configure():
    container='cmcc-apps-gateway-1'
    result=subprocess.run(['docker','inspect',container],capture_output=True,text=True)
    if result.returncode:
        print('No existing CMCC gateway; dedicated SONA entry retained.')
        return
    info=json.loads(result.stdout)[0]
    config=pathlib.Path('/opt/cmcc-apps/config/gateway-nginx.conf')
    mounts=info['Mounts']
    if not any(m.get('Source')==str(config) and m.get('Destination')=='/etc/nginx/conf.d/default.conf' for m in mounts):
        raise SystemExit('Unexpected CMCC gateway config mount; refusing to replace it.')
    network=info['NetworkSettings']['Networks'].get('cmcc-apps_doclens')
    if not network or not network.get('Gateway'):
        raise SystemExit('Expected CMCC gateway host network unavailable.')
    host=network['Gateway']
    old=config.read_text()
    marker='# SONA shared gateway routes'
    if marker in old:
        print('CMCC SONA routes already configured.')
        return
    if old.count('    location / { return 404; }')!=1 or old.count('    location = / {')!=1:
        raise SystemExit('Unexpected CMCC gateway route structure; manual review required.')
    routes=f'''    {marker}
    location = /sona {{ proxy_pass http://{host}:20281; }}
    location /sona/ {{ proxy_pass http://{host}:20281; }}
    location ~ ^/(_account/|_orx/|api/|_next/|abs/|library(?:/|$)|account(?:/|$)|blog(?:/|$)|researchers(?:/|$)|papers/|platform\\.js$|platform\\.css$|healthz$) {{
        client_max_body_size 100m;
        proxy_read_timeout 3600s;
        proxy_pass http://{host}:20281;
    }}
'''
    new=old.replace('    location / { return 404; }',routes+'    location / { return 404; }')
    new=new.replace('    location = / {','    location = / {\n        if ($arg_continue != "") { return 302 /_account/login$is_args$args; }',1)
    backup=config.with_name(config.name+'.sona-backup-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.write_bytes(config.read_bytes());backup.chmod(0o600)
    # Keep the bind-mounted inode so the running container sees the change.
    try:
        config.write_text(new)
        subprocess.run(['docker','exec',container,'nginx','-t'],check=True)
        subprocess.run(['docker','exec',container,'nginx','-s','reload'],check=True)
    except BaseException:
        config.write_text(old)
        subprocess.run(['docker','exec',container,'nginx','-s','reload'],check=False)
        raise
    print('CMCC SONA routes configured; original routes retained. Backup:',backup)


if __name__=='__main__':configure()

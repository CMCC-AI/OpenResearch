"""Extend the known CMCC gateway without replacing its existing application routes."""
import datetime,json,pathlib,subprocess,re


def configure(backup_dir=None):
    container='cmcc-apps-gateway-1'
    result=subprocess.run(['docker','inspect',container],capture_output=True,text=True)
    if result.returncode:
        print('No existing CMCC gateway; dedicated MobileSci entry retained.')
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
    marker='# MobileSci shared gateway routes'
    if old.count('    location / { return 404; }')!=1 or old.count('    location = / {')!=1:
        raise SystemExit('Unexpected CMCC gateway route structure; manual review required.')
    routes=f'''    {marker}
    location = /mobilesci {{ proxy_pass http://{host}:20281; }}
    location /mobilesci/ {{ proxy_pass http://{host}:20281; }}
    location = /deepxiv {{ proxy_pass http://{host}:20281; }}
    location /deepxiv/ {{ proxy_pass http://{host}:20281; }}
    location ~ ^/(_account/|_orx/|api/|_next/|abs/|library(?:/|$)|account(?:/|$)|blog(?:/|$)|researchers(?:/|$)|papers/|platform\\.js$|platform\\.css$|favicon\\.ico$|healthz$) {{
        client_max_body_size 100m;
        proxy_read_timeout 3600s;
        proxy_pass http://{host}:20281;
    }}
'''
    if marker not in old:
        new=old.replace('    location / { return 404; }',routes+'    location / { return 404; }')
        new=new.replace('    location = / {','    location = / {\n        if ($arg_continue != "") { return 302 /_account/login$is_args$args; }',1)
    else:
        new=old.replace('platform\\.css$|healthz$', 'platform\\.css$|favicon\\.ico$|healthz$')
    root_marker='# MobileSci literature homepage by public host'
    if root_marker not in new:
        root=re.search(r'(?ms)^    location = / \{\n(.*?)^    \}',new)
        if not root:raise SystemExit('Unexpected CMCC homepage structure; manual review required.')
        returned=re.search(r'(?m)^        return 200 .*;$',root.group(1))
        if not returned:raise SystemExit('Unexpected CMCC homepage response; manual review required.')
        body=root.group(1).replace(returned.group(0),
            '        '+root_marker+'\n        if ($http_host != "61.136.101.179:20281") {\n    '+returned.group(0)+'\n        }\n        proxy_pass http://'+host+':20281;',1)
        new=new[:root.start(1)]+body+new[root.end(1):]
    if '    location /deepxiv/' not in new:
        new=new.replace('    # MobileSci shared gateway routes',
            '    location = /deepxiv { proxy_pass http://'+host+':20281; }\n    location /deepxiv/ { proxy_pass http://'+host+':20281; }\n    # MobileSci shared gateway routes',1)
    image_marker='# MobileSci legacy research image paths'
    if image_marker not in new:
        image_routes='    '+image_marker+'\n    location ^~ /research-experts/ { add_header Cache-Control "no-store" always; return 302 /mobilesci$request_uri; }\n    location ^~ /research-team/ { add_header Cache-Control "no-store" always; return 302 /mobilesci$request_uri; }\n'
        new=new.replace('    location / { return 404; }',image_routes+'    location / { return 404; }',1)
    if new==old:
        print('CMCC MobileSci routes already configured.')
        return
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=(pathlib.Path(backup_dir)/('gateway-nginx-'+stamp+'.conf')) if backup_dir else config.with_name(config.name+'.mobilesci-backup-'+stamp)
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
    print('CMCC MobileSci routes configured; original routes retained. Backup:',backup)


if __name__=='__main__':configure()

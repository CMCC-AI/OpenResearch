"""Adapt only the disposable DeepXiv build copy for MobileSci's /deepxiv deployment."""
import pathlib,re

PREFIX='/deepxiv'

def replace_once(path, old, new):
    text=path.read_text()
    if text.count(old)!=1:raise ValueError(f'DeepXiv adapter source changed: {path.name}')
    path.write_text(text.replace(old,new))

def adapt(folder):
    folder=pathlib.Path(folder)
    replace_once(folder/'next.config.ts',"output: 'standalone',", "output: 'standalone',\n  basePath: '/deepxiv',\n  skipTrailingSlashRedirect: true,")
    replace_once(folder/'src/lib/sso-config.ts',"if (url.protocol !== 'https:' && url.hostname !== 'localhost') {", "if (url.protocol !== 'https:' && url.hostname !== 'localhost' && !(url.protocol === 'http:' && url.origin === process.env.DEEPLIT_INSECURE_PUBLIC_ORIGIN)) {")
    replace_once(folder/'src/lib/sso-config.ts','redirectUri: `${publicOrigin}/api/auth/openresearch/callback`', 'redirectUri: `${publicOrigin}/deepxiv/api/auth/openresearch/callback`')
    replace_once(folder/'src/app/api/auth/openresearch/complete/route.ts',"new URL('/projects', destination)","new URL(`${process.env.DEEPLIT_OPENRESEARCH_APP_PATH || ''}/projects`, destination)")
    replace_once(folder/'src/app/api/auth/openresearch/callback/route.ts','new URL(flow.returnTo, config.publicOrigin)',"new URL(flow.returnTo === '/deepxiv' || flow.returnTo.startsWith('/deepxiv/') ? flow.returnTo : `/deepxiv${flow.returnTo}`, config.publicOrigin)")
    for file in (folder/'src').rglob('*.tsx'):
        text=file.read_text()
        # Next Link/router handle their own basePath. Native fetch and anchors do not.
        text=re.sub(r'([\'"`])/api/',r'\1/deepxiv/api/',text)
        text=text.replace('${window.location.origin}/abs/', '${window.location.origin}/deepxiv/abs/')
        text=re.sub(r'<a\b[^>]*>',lambda m:re.sub(r'(href=\{?)([\'"`])/(?!/|deepxiv)',r'\1\2/deepxiv/',m.group(0)),text)
        if file.name=='EmbeddedAuthBoundary.tsx':
            text=text.replace('window.location.assign(platformOrigin)',"window.location.assign(`${platformOrigin}/mobilesci`)")
            text=text.replace('登录 OpenResearch 后','登录 MobileSci 后').replace('进入 OpenResearch 登录','进入 MobileSci 登录').replace('连接 OpenResearch 与 DeepLiterature','连接 MobileSci 与 DeepXiv')
        file.write_text(text)
    store=folder/'src/lib/papers/store.ts'
    store.write_text(re.sub(r'([\'"`])/api/',r'\1/deepxiv/api/',store.read_text()))
    (folder/'prefix-server.cjs').write_text(pathlib.Path(__file__).with_name('deepxiv-prefix-server.cjs').read_text())
    replace_once(folder/'Dockerfile','CMD ["node", "server.js"]','COPY --from=builder --chown=nextjs:nodejs /app/prefix-server.cjs ./prefix-server.cjs\nCMD ["node", "prefix-server.cjs"]')

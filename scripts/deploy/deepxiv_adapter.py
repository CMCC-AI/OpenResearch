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
    replace_once(folder/'src/app/layout.tsx',"import { isManagedAuth, ssoConfig } from '@/lib/sso-config';","import { getCurrentUser } from '@/lib/auth';\nimport { isManagedAuth, ssoConfig } from '@/lib/sso-config';")
    replace_once(folder/'src/app/layout.tsx',"""  await connection();
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <EmbeddedAuthBoundary platformOrigin={isManagedAuth() ? ssoConfig().platformOrigin : null}>""","""  await connection();
  const managed = isManagedAuth();
  let initialUserId: string | null = null;
  let initialError = false;
  if (managed) {
    try {
      initialUserId = (await getCurrentUser())?.id ?? null;
    } catch {
      initialError = true;
    }
  }
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <EmbeddedAuthBoundary platformOrigin={managed ? ssoConfig().platformOrigin : null} initialUserId={initialUserId} initialError={initialError}>""")
    for file in (folder/'src').rglob('*.tsx'):
        text=file.read_text()
        # Next Link/router handle their own basePath. Native fetch and anchors do not.
        text=re.sub(r'([\'"`])/api/',r'\1/deepxiv/api/',text)
        text=text.replace('${window.location.origin}/abs/', '${window.location.origin}/deepxiv/abs/')
        text=re.sub(r'<a\b[^>]*>',lambda m:re.sub(r'(href=\{?)([\'"`])/(?!/|deepxiv)',r'\1\2/deepxiv/',m.group(0)),text)
        if file.name=='EmbeddedAuthBoundary.tsx':
            text=text.replace('window.location.assign(platformOrigin)',"window.location.assign(`${platformOrigin}/mobilesci`)")
            text=text.replace("""export function EmbeddedAuthBoundary({
  children,
  platformOrigin,
}: {
  children: ReactNode;
  platformOrigin: string | null;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'anonymous' | 'error'>(
    platformOrigin ? 'loading' : 'ready',
  );
  const [storagePrefix, setStoragePrefix] = useState('');""","""export function EmbeddedAuthBoundary({
  children,
  platformOrigin,
  initialUserId = null,
  initialError = false,
}: {
  children: ReactNode;
  platformOrigin: string | null;
  initialUserId?: string | null;
  initialError?: boolean;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'anonymous' | 'error'>(
    platformOrigin ? (initialError ? 'error' : initialUserId ? 'ready' : 'loading') : 'ready',
  );
  const [storagePrefix, setStoragePrefix] = useState(
    initialUserId ? `deeplit_user_${initialUserId}:` : '',
  );""")
            text=text.replace("const [storagePrefix, setStoragePrefix] = useState(\n    initialUserId ? `deeplit_user_${initialUserId}:` : '',\n  );","const [storagePrefix, setStoragePrefix] = useState(\n    initialUserId ? `deeplit_user_${initialUserId}:` : '',\n  );\n  const [manualLogin, setManualLogin] = useState(false);")
            text=text.replace("  }, [platformOrigin]);\n\n  const logout = () => {", """  }, [platformOrigin]);

  useEffect(() => {
    if (!platformOrigin || status !== 'anonymous') return;
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const key = 'deeplit_auto_sso_at';
    const now = Date.now();
    try {
      const last = Number(window.sessionStorage.getItem(key) || '0');
      if (Number.isFinite(last) && now - last < 15_000) {
        setManualLogin(true);
        return;
      }
      window.sessionStorage.setItem(key, String(now));
    } catch {
      setManualLogin(true);
      return;
    }
    window.location.replace(`/deepxiv/api/auth/openresearch/start?returnTo=${encodeURIComponent(returnTo)}`);
  }, [platformOrigin, status]);

  const logout = () => {""")
            text=text.replace("status === 'error' ? '认证服务暂时不可用' : '使用科研平台账户登录'","status === 'error' ? '认证服务暂时不可用' : manualLogin ? '使用科研平台账户登录' : '正在自动登录'")
            text=text.replace("status === 'anonymous'\n              ? '登录 OpenResearch 后即可继续阅读论文、保存笔记并返回研究工作流。'","status === 'anonymous'\n              ? (manualLogin ? '登录 MobileSci 后即可继续阅读论文、保存笔记并返回研究工作流。' : '正在为您同步 MobileSci 登录状态并进入阅读…')")
            text=text.replace("{status === 'anonymous' && (","{status === 'anonymous' && manualLogin && (")
            text=text.replace('登录 OpenResearch 后','登录 MobileSci 后').replace('进入 OpenResearch 登录','进入 MobileSci 登录').replace('连接 OpenResearch 与 DeepLiterature','连接 MobileSci 与 DeepXiv')
        file.write_text(text)
    store=folder/'src/lib/papers/store.ts'
    store.write_text(re.sub(r'([\'"`])/api/',r'\1/deepxiv/api/',store.read_text()))
    (folder/'prefix-server.cjs').write_text(pathlib.Path(__file__).with_name('deepxiv-prefix-server.cjs').read_text())
    replace_once(folder/'Dockerfile','CMD ["node", "server.js"]','COPY --from=builder --chown=nextjs:nodejs /app/prefix-server.cjs ./prefix-server.cjs\nCMD ["node", "prefix-server.cjs"]')

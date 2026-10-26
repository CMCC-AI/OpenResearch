import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction, RefObject, KeyboardEvent, ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight, ArrowDown, Play, Pause, X, Check, CircleCheck as CheckCircle, Copy, Users as UsersThree, GitBranch, ShieldCheck, RefreshCw as ArrowsClockwise, Layers as Stack, Maximize as Expand } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { stages, mechanisms, trinity, prompts } from "./landingContent";
import { ResearchDiagram } from "./LandingResearchDiagram";
import { landingAsset } from "./landingAssets";
import { useAuthSession } from "./AuthSession";
import "./landing.css";

type Modal = { type: "image"; image: string; title: string; } | { type: "prompt"; title: string; body: string; stage?: number; };
type StateSetter<T> = Dispatch<SetStateAction<T>>;
function handleTabKeys(event: KeyboardEvent<HTMLElement>) {
  const keys = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
  ];
  if (!keys.includes(event.key) || (event.target as HTMLElement).getAttribute("role") !== "tab")
    return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')],
    i = tabs.indexOf(event.target as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (i +
            (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) +
            tabs.length) %
          tabs.length;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}
const icons: Record<string, LucideIcon> = {
  branch: GitBranch,
  cycle: ArrowsClockwise,
  users: UsersThree,
  shield: ShieldCheck,
};
function useVisible(ref: RefObject<HTMLElement | null>, margin = "0px", threshold = 0.1) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([e]) => setVisible(e.isIntersecting),
      { rootMargin: margin, threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, margin, threshold]);
  return visible;
}
function useReduced() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(q.matches);
    sync();
    q.addEventListener("change", sync);
    return () => q.removeEventListener("change", sync);
  }, []);
  return reduced;
}
function Media({ name, alt, priority = false, className = "" }: { name: string; alt: string; priority?: boolean; className?: string }) {
  return (
    <img
      className={className}
      src={landingAsset(`${name}-1800.webp`)}
      srcSet={`${landingAsset(`${name}-960.webp`)} 960w, ${landingAsset(`${name}-1800.webp`)} 1800w`}
      sizes="(max-width: 700px) 94vw, (max-width: 1100px) 85vw, 1100px"
      alt={alt}
      width="1800"
      height={name === "start" ? 1125 : 1013}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
    />
  );
}
function SectionHeading({ eyebrow, title, description, center = false }: { eyebrow: string; title: ReactNode; description?: string; center?: boolean }) {
  return (
    <div className={`section-heading ${center ? "center" : ""}`}>
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {description && <p className="section-description">{description}</p>}
    </div>
  );
}
function Brand({ footer = false }: { footer?: boolean }) {
  return (
    <a
      href="#top"
      className={`brand ${footer ? "brand-footer" : ""}`}
      aria-label="MobileSci 首页"
    >
      <img src={landingAsset("jiutian.webp")} width="32" height="32" alt="九天" />
      <strong>MobileSci</strong>
    </a>
  );
}
function ProductVideo() {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useVisible(ref);
  const reduced = useReduced();
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(true);
  const screens = [
    ["project", "研究项目"],
    ["capabilities", "科研能力"],
    ["conversation", "研究对话"],
    ["experts", "科研专家团"],
  ];
  useEffect(() => {
    if (!visible || !playing || reduced) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        setSelected((i) => (i + 1) % screens.length);
    }, 4800);
    return () => clearInterval(timer);
  }, [visible, playing, reduced, selected]);
  return (
    <div className="hero-showcase" ref={ref}>
      <div className="showcase-top">
        <span>
          <i className="status-dot" /> MobileSci 科研工作台
        </span>
        <span className="tour-label">产品界面导览</span>
      </div>
      <div
        className="carousel-window"
        aria-roledescription="轮播"
        aria-label="MobileSci 产品界面"
      >
        <div
          className="carousel-track"
          style={{ transform: `translateX(-${selected * 100}%)` }}
        >
          {screens.map(([image, title], i) => (
            <div
              className="carousel-slide"
              key={image}
              aria-hidden={i !== selected}
            >
              <Media
                name={image}
                alt={`MobileSci ${title}界面`}
                priority={i === 0}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="carousel-toolbar">
        <span className="carousel-current">{screens[selected][1]}</span>
        <div className="carousel-dots" aria-label="选择产品界面">
          {screens.map(([, title], i) => (
            <button
              key={title}
              className={selected === i ? "active" : ""}
              aria-label={`查看${title}`}
              aria-pressed={selected === i}
              onClick={() => {
                setSelected(i);
                setPlaying(false);
              }}
            />
          ))}
        </div>
        <button
          className="carousel-play"
          aria-label={playing ? "暂停产品导览" : "播放产品导览"}
          onClick={() => setPlaying((v) => !v)}
        >
          {playing ? (
            <Pause size={14} />
          ) : (
            <Play size={14} />
          )}
        </button>
      </div>
    </div>
  );
}
function Workflow({ onZoom, selected, setSelected }: { onZoom: (image: string, title: string) => void; selected: number; setSelected: StateSetter<number> }) {
  const ref = useRef<HTMLDivElement>(null),
    visible = useVisible(ref);
  const reduced = useReduced();
  const [auto, setAuto] = useState(true),
    [cycle, setCycle] = useState(0);
  useEffect(() => {
    if (!visible || !auto || reduced) return;
    const timer = setInterval(() => {
      setSelected((i) => (i + 1) % stages.length);
      setCycle((c) => c + 1);
    }, 7000);
    return () => clearInterval(timer);
  }, [visible, auto, reduced, selected, setSelected]);
  const active = stages[selected];
  return (
    <section id="workflow" className="section workflow" ref={ref}>
      <SectionHeading
        eyebrow="THE RESEARCH JOURNEY"
        title="科研全流程自动化接管"
        description="从发现问题到形成成果，五个阶段、二十多个科研环节，在同一个研究项目中持续衔接。"
      />
      <div className="workflow-layout">
        <div
          className="vertical-tabs"
          role="tablist"
          onKeyDown={handleTabKeys}
          aria-label="科研流程"
        >
          {stages.map((s, i) => (
            <button
              key={s.id}
              role="tab"
              id={`stage-${s.id}`}
              aria-controls="stage-panel"
              tabIndex={i === selected ? 0 : -1}
              aria-selected={i === selected}
              onClick={() => {
                setSelected(i);
                setAuto(false);
              }}
              className={i === selected ? "active" : ""}
            >
              <span className="tab-heading">
                <span className="tab-number">0{i + 1}</span>
                {s.label}
              </span>
              <span className="tab-description">{s.description}</span>
              <span className="progress-track">
                <span
                  key={`${selected}-${cycle}`}
                  className={
                    i === selected && auto && visible && !reduced
                      ? "progress-fill running"
                      : "progress-fill"
                  }
                  style={{ animationPlayState: visible ? "running" : "paused" }}
                />
              </span>
            </button>
          ))}
          <button
            className="autoplay-toggle"
            onClick={() => setAuto((v) => !v)}
            aria-label={auto ? "暂停流程轮播" : "播放流程轮播"}
          >
            {auto ? <Pause size={13} /> : <Play size={13} />}{" "}
            {auto ? "暂停轮播" : "自动浏览"}
          </button>
        </div>
        <div
          id="stage-panel"
          role="tabpanel"
          aria-labelledby={`stage-${active.id}`}
          className={`workflow-panel panel-${active.color}`}
        >
          <div key={active.id} className="workflow-panel-inner">
            <div className="panel-copy">
              <span className="mini-eyebrow">{active.en}</span>
              <h3>{active.title}</h3>
              <div className="tag-list">
                {active.tags.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            </div>
            <button
              className="screen-button"
              onClick={() => onZoom(active.image, active.label)}
              aria-label={`放大${active.label}产品界面`}
            >
              <Media
                name={active.image}
                alt={`MobileSci ${active.label}产品设计界面`}
              />
              <span className="expand-label">
                <Expand size={15} /> 查看界面
              </span>
            </button>
            <div className="outcome">
              <CheckCircle size={17} />
              <span>{active.outcome}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
function Mechanisms() {
  const [selected, setSelected] = useState(0);
  const m = mechanisms[selected];
  return (
    <section className="section advantages" id="technology">
      <SectionHeading
        eyebrow="BUILT FOR REAL RESEARCH"
        title="核心技术优势，让复杂研究持续向前"
        description="四项能力优势，承接长程执行、反复验证与关键决策。"
      />
      <div className="advantage-layout">
        <div
          className="advantage-tabs"
          role="tablist"
          aria-label="能力优势"
          aria-orientation="vertical"
          onKeyDown={handleTabKeys}
        >
          {mechanisms.map((item, i) => {
            const Icon = icons[item.icon];
            return (
              <button
                key={item.label}
                role="tab"
                id={`advantage-${i}`}
                aria-controls="advantage-panel"
                aria-selected={selected === i}
                tabIndex={selected === i ? 0 : -1}
                onClick={() => setSelected(i)}
              >
                <span className="advantage-topic">
                  <Icon size={21} />
                  <strong>{item.label}</strong>
                  <ArrowRight size={17} />
                </span>
                <span className="advantage-sentence">{item.subtitle}</span>
                {selected === i && (
                  <span className="advantage-description">{item.text}</span>
                )}
              </button>
            );
          })}
        </div>
        <div
          className="advantage-panel"
          role="tabpanel"
          id="advantage-panel"
          aria-labelledby={`advantage-${selected}`}
        >
          <ResearchDiagram selected={selected} />
          <p className="advantage-mobile-description">{m.text}</p>
          <div className="advantage-legend">
            {m.steps.map((step, i) => (
              <span key={step}>
                <i>0{i + 1}</i>
                {step}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
function Trinity() {
  const [selected, setSelected] = useState(0);
  const item = trinity[selected];
  return (
    <section className="trinity-section" id="trinity">
      <div className="section">
        <SectionHeading
          eyebrow="THREE PILLARS. ONE RESEARCH EXPERIENCE."
          title="科研工具 × 科学算力 × 科学数据"
          description="三位一体，让研究的想法、执行与积累彼此支撑。"
        />
        <div className="trinity-layout">
          <div
            className="trinity-illustration"
            role="tablist"
            aria-label="三位一体能力"
            onKeyDown={handleTabKeys}
          >
            <img
              className="trinity-art-image"
              src={landingAsset("trinity-sculpture-960.webp")}
              srcSet={`${landingAsset("trinity-sculpture-480.webp")} 480w, ${landingAsset("trinity-sculpture-960.webp")} 960w`}
              sizes="(max-width: 760px) 90vw, 42vw"
              width="1254"
              height="1254"
              alt="三位一体原创三角雕塑：科研工具、科学算力与科学数据共同支撑 MobileSci"
              loading="lazy"
              decoding="async"
            />
            {trinity.map((x, i) => (
              <button
                key={x.name}
                className={`trinity-image-tab image-tab-${i}`}
                id={`pillar-${i}`}
                role="tab"
                aria-selected={selected === i}
                tabIndex={selected === i ? 0 : -1}
                aria-controls="pillar-panel"
                aria-label={x.name}
                onClick={() => setSelected(i)}
              >
                <span className="sr-only">{x.name}</span>
              </button>
            ))}
          </div>
          <div
            className="pillar-copy"
            role="tabpanel"
            id="pillar-panel"
            aria-labelledby={`pillar-${selected}`}
          >
            <span className="pillar-eyebrow">
              0{selected + 1} / {item.en}
            </span>
            <h3>{item.headline}</h3>
            <p>{item.text}</p>
            <div className="pillar-tags">
              {item.tags.map((tag) => (
                <span key={tag}>
                  <CheckCircle size={16} />
                  {tag}
                </span>
              ))}
            </div>
            <span className="pillar-hint">
              点击图中三项能力，探索每一份支撑 <ArrowRight size={14} />
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
function Benchmark() {
  return (
    <section className="section benchmark-editorial" id="benchmark">
      <div className="benchmark-intro">
        <span className="eyebrow">END-TO-END SCIENTIFIC RESEARCH</span>
        <h2>ResearchClawBench</h2>
        <p className="benchmark-summary">10 个科学领域，40 个真实科研问题</p>
        <p className="benchmark-description">
          从研究规划、代码实现到实验验证，
          <br />
          以端到端科研任务检验智能体的综合能力。
        </p>
      </div>
      <span className="benchmark-slash" aria-hidden="true">
        /
      </span>
      <div className="benchmark-achievement">
        <span className="eyebrow">BENCHMARK ACHIEVEMENT</span>
        <h3>综合第一</h3>
        <p className="benchmark-five">
          <strong>5</strong> 个学科第一
        </p>
        <div className="benchmark-subjects">
          {["天文", "化学", "能源", "信息科学", "物理"].map((x) => (
            <span key={x}>{x}</span>
          ))}
        </div>
      </div>
    </section>
  );
}
function PromptWall({ onPrompt }: { onPrompt: (title: string, body: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useVisible(ref);
  return (
    <section className="prompt-section" ref={ref}>
      <div className="section prompt-heading">
        <SectionHeading
          eyebrow="A STARTING POINT FOR EVERY QUESTION"
          title="让每一个科研问题，都有一个开始"
          description="从日常文献理解，到复杂实验探索。选择一项任务，看看 MobileSci 怎样接续你的研究。"
        />
      </div>
      <div className="prompt-viewport">
        {[prompts.slice(0, 12), prompts.slice(12)].map((row, r) => (
          <div className={`prompt-track track-${r}`} key={r} style={{ animationPlayState: visible ? "running" : "paused" }}>
            {[...row, ...row].map(([title, body], i) => (
              <button
                className="prompt-card"
                key={`${title}-${i}`}
                onClick={() => onPrompt(title, body)}
                tabIndex={i >= row.length ? -1 : 0}
                aria-hidden={i >= row.length ? true : undefined}
              >
                <span>
                  <Stack size={19} />
                  {title}
                  <ArrowUpRight size={16} className="prompt-arrow" />
                </span>
                <p>{body}</p>
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
function DialogContent({ modal, setModal, setStage }: { modal: Modal | null; setModal: StateSetter<Modal | null>; setStage: StateSetter<number> }) {
  const ref = useRef<HTMLDialogElement>(null),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (modal) {
      dialog.showModal();
      setCopied(false);
    } else dialog.close();
  }, [modal]);
  async function copy() {
    try {
      if (modal?.type !== "prompt") return;
      await navigator.clipboard.writeText(modal.body);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <dialog
      ref={ref}
      aria-label={modal?.title || "研究详情"}
      className={`site-dialog ${modal?.type === "image" ? "image-dialog" : ""}`}
      onCancel={() => setModal(null)}
      onClick={(e) => {
        if (e.target === ref.current) setModal(null);
      }}
    >
      <button
        className="dialog-close"
        onClick={() => setModal(null)}
        aria-label="关闭弹窗"
      >
        <X size={22} />
      </button>
      {modal?.type === "image" ? (
        <>
          <h2>{modal.title}</h2>
          <Media name={modal.image} alt={modal.title} />
          <p className="dialog-caption">
            MobileSci 产品设计界面 · 保持原始比例
          </p>
        </>
      ) : modal?.type === "prompt" ? (
        <>
          <span className="mini-eyebrow">YOUR NEXT RESEARCH QUESTION</span>
          <h2>{modal.title}</h2>
          <p className="prompt-detail">{modal.body}</p>
          <div className="dialog-actions">
            <button className="button button-dark" onClick={copy}>
              {copied ? <Check size={17} /> : <Copy size={17} />}{" "}
              {copied ? "已复制研究问题" : "复制研究问题"}
            </button>
            <button
              className="text-button"
              onClick={() => {
                setStage(modal.stage ?? 0);
                setModal(null);
                document
                  .getElementById("workflow")
                  ?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
              }}
            >
              查看相关能力 <ArrowRight size={17} />
            </button>
          </div>
          <p className="dialog-caption">
            将问题带入你的研究，或继续探索科研全流程。
          </p>
        </>
      ) : null}
    </dialog>
  );
}
function useScrollReveal() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const elements = [
      ...document.querySelectorAll(
        ".product-landing .section-heading,.product-landing .advantage-art,.product-landing .trinity-illustration",
      ),
    ];
    elements.forEach((e) => e.classList.add("scroll-reveal"));
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach(({ isIntersecting, target }) => {
          if (isIntersecting) {
            target.classList.add("is-visible");
            observer.unobserve(target);
          }
        }),
      { threshold: 0.06, rootMargin: "0px 0px -20px 0px" },
    );
    elements.forEach((e) => observer.observe(e));
    return () => {
      observer.disconnect();
      elements.forEach((e) =>
        e.classList.remove("scroll-reveal", "is-visible"),
      );
    };
  }, []);
}
export function LandingPage() {
  const pageRef = useRef<HTMLDivElement>(null);
  const { loading, user, login } = useAuthSession();
  const navigate = useNavigate();
  const startResearch = () => {
    if (user) void navigate({ to: "/projects", search: { new: true } });
    else login();
  };
  useScrollReveal();
  const [scrolled, setScrolled] = useState(false),
    [stage, setStage] = useState(0),
    [modal, setModal] = useState<Modal | null>(null);
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const sync = () => setScrolled(page.scrollTop > 540);
    page.addEventListener("scroll", sync, { passive: true });
    sync();
    return () => page.removeEventListener("scroll", sync);
  }, []);
  const zoom = (image: string, title: string) => setModal({ type: "image", image, title });
  return (
    <div ref={pageRef} className="product-landing h-full overflow-y-auto" lang="zh-CN">
      <a className="skip-link" href="#workflow">
        跳转到产品内容
      </a>
      <header className={`site-header ${scrolled ? "light" : ""}`}>
        <Brand />
        <nav aria-label="页面导航">
          <a href="#workflow">科研能力</a>
          <a href="#technology">能力优势</a>
          <a href="#trinity">三位一体</a>
          <a href="#benchmark">能力验证</a>
        </nav>
        <button className="nav-cta" type="button" disabled={loading} onClick={startResearch}>
          开始探索 <ArrowUpRight size={14} />
        </button>
      </header>
      <main>
        <section id="top" className="hero">
          <div className="hero-copy">
            <img
              className="hero-mark"
              src={landingAsset("science-mark.webp")}
              alt="MobileSci 玻璃科学雕塑"
              width="133"
              height="133"
              fetchPriority="high"
            />
            <p className="hero-product">
              <strong>MobileSci</strong>
              <span>AI for Science</span>
              <span>AI 原生科研应用平台</span>
            </p>
            <h1>
              <span>从一个 Idea，</span>
              <span>到一篇 Paper</span>
            </h1>
            <p className="hero-description">
              连接文献、代码、数据与实验，
              <br className="mobile-break" />
              让科研智能体与你共同推进每一次研究
            </p>
            <button className="button button-white hero-cta" disabled={loading} onClick={startResearch}>
              开始一项研究 <ArrowRight size={18} />
            </button>
            <a className="hero-explore" href="#workflow">
              探索 AI 原生科研应用平台 <ArrowDown size={13} />
            </a>
          </div>
          <ProductVideo />
          <div className="hero-trust">
            <span>
              从任何阶段进入，
              <br className="mobile-break" />
              在同一项目中持续研究
            </span>
            <div>
              <strong>5</strong>
              <span>科研阶段</span>
            </div>
            <div>
              <strong>
                20<span>+</span>
              </strong>
              <span>科研环节</span>
            </div>
            <div>
              <strong>
                30<span>+</span>
              </strong>
              <span>专业智能体</span>
            </div>
          </div>
        </section>
        <Workflow selected={stage} setSelected={setStage} onZoom={zoom} />
        <Mechanisms />
        <Trinity />
        <Benchmark />
        <PromptWall
          onPrompt={(title, body) => setModal({ type: "prompt", title, body, stage: Math.max(0, stages.findIndex((item) => item.tags.includes(title))) })}
        />
        <section className="closing" id="explore">
          <img
            src={landingAsset("science-mark.webp")}
            width="72"
            height="72"
            alt=""
            loading="lazy"
          />
          <h2>
            下一个研究问题，
            <br className="mobile-break" />
            从这里向前一步
          </h2>
          <p>
            面向高校师生、科研院所与企业研发团队
            <br />
            让科研智能体、科学算力与科学数据，成为你的研究助力。
          </p>
          <button className="button button-dark" disabled={loading} onClick={startResearch}>
            探索 MobileSci <ArrowRight size={18} />
          </button>
          <span className="closing-note">科研工具 × 科学算力 × 科学数据</span>
        </section>
      </main>
      <footer>
        <Brand footer />
        <span>中国移动 · 数据能力研发中心</span>
        <span className="footer-copyright">
          © {new Date().getFullYear()} MobileSci
        </span>
        <a href="#top">
          返回顶部 <ArrowUpRight size={14} />
        </a>
      </footer>
      <DialogContent modal={modal} setModal={setModal} setStage={setStage} />
    </div>
  );
}

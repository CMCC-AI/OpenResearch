import { Link } from "@tanstack/react-router";
import { useAuthSession } from "./AuthSession";
import arrow from "../assets/landing/arrow.svg";
import brand from "../assets/landing/brand.svg";
import dashboard from "../assets/landing/dashboard.png";
import discover from "../assets/landing/discover.png";
import experiment from "../assets/landing/experiment.png";
import hypothesis from "../assets/landing/hypothesis.png";
import results from "../assets/landing/results.png";
import scientist from "../assets/landing/scientist.png";
import scientistDetail from "../assets/landing/scientist-detail.png";
import "./landing.css";

const journey = [
  { image: discover, slot: "discover", title: "发现论文", text: "连接 alphaXiv、bioRxiv 与 OpenAlex，寻找真正相关的研究。" },
  { image: hypothesis, slot: "hypothesis", title: "形成假设", text: "让科研 Agent 梳理证据、识别空白并定义可检验问题。" },
  { image: experiment, slot: "experiment", title: "执行实验", text: "在 Git 分支和隔离运行中复现、迭代并保留完整日志。" },
  { image: results, slot: "results", title: "沉淀成果", text: "分析结果、制作图表、撰写论文并导出可复现研究包。" },
];

function ActionArrow() {
  return <img src={arrow} alt="" width="15.0082" height="10.3487" aria-hidden="true" />;
}

export function LandingPage() {
  const { loading, user, login } = useAuthSession();
  return <main className="product-landing h-full overflow-y-auto" lang="zh-CN">
    <div className="landing-intro">
      <header className="landing-header flex items-center justify-between gap-4">
        <Link to="/" className="landing-brand inline-flex items-center no-underline" aria-label="MobileSci 介绍页">
          <img src={brand} alt="" width="38" height="38" />
          <span>MobileSci</span>
        </Link>
        {user
          ? <Link to="/projects" className="landing-button landing-login no-underline">进入科研首页 <ActionArrow /></Link>
          : <button type="button" disabled={loading} onClick={login} className="landing-button landing-login">登录 <ActionArrow /></button>}
      </header>
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-copy">
          <h1 id="landing-title">让科研智能体<br /><span>与你共同推进每一次研究</span></h1>
          <p className="landing-description">贯通论文发现、研究构思、实验验证、结果分析与科学写作。所有过程都有项目、代码、日志与证据可追溯。</p>
          <div className="landing-sources">
            <p>论文渠道</p>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="支持的论文渠道">
              {["alphaXiv", "bioRxiv", "OpenAlex", "Deep Literature"].map((source) => <li key={source}>{source}</li>)}
            </ul>
          </div>
          <div className="landing-actions flex flex-wrap gap-2">
            {user
              ? <Link to="/projects" search={{ new: true }} className="landing-button no-underline">开始研究 <ActionArrow /></Link>
              : <button type="button" disabled={loading} onClick={login} className="landing-button">开始研究 <ActionArrow /></button>}
            <a href="#product" className="landing-button landing-button-secondary no-underline">了解能力</a>
          </div>
        </div>
        <div className="landing-art" aria-hidden="true">
          <div className="landing-scene-shape" />
          <div className="landing-scene" />
          <img className="landing-dashboard" src={dashboard} alt="" width="1024" height="960" />
          <img className="landing-scientist" src={scientist} alt="" width="1318" height="1704" fetchPriority="high" />
          <img className="landing-scientist-detail" src={scientistDetail} alt="" width="1856" height="2400" />
        </div>
      </section>
    </div>
    <section id="product" className="landing-product" aria-labelledby="landing-product-title">
      <h2 id="landing-product-title">从问题到可信成果，<span>持续迭代</span></h2>
      <div className="landing-journey grid grid-cols-4 gap-6">
        {journey.map(({ image, slot, title, text }) => <article key={title} className="landing-card relative overflow-hidden rounded-2xl">
          <div className={`landing-card-image landing-card-image-${slot}`}><img src={image} alt="" loading="lazy" /></div>
          <div className="landing-card-copy"><h3>{title}</h3><p>{text}</p></div>
        </article>)}
      </div>
    </section>
  </main>;
}

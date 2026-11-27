export function WorkflowFlowchartSvg() {
  return (
    <svg
      className="workflow-vector-svg"
      viewBox="0 0 1200 660"
      fill="none"
      role="img"
      aria-label="MobileSci 科研全流程流程图：01 发现与理解、02 构思与定义、03 方法与实验设计、04 实现与验证、05 分析与表达，包含各阶段具体科研环节展开与反馈闭环"
    >
      <defs>
        <linearGradient id="wfCanvasGrad" x1="0" y1="0" x2="1200" y2="660" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e6f0ff" />
          <stop offset="0.34" stopColor="#f3f8ff" />
          <stop offset="1" stopColor="#ffffff" />
        </linearGradient>
        <radialGradient id="wfGlowLeft" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(180 540) rotate(-25) scale(460 320)">
          <stop offset="0" stopColor="#bfdbfe" stopOpacity="0.45" />
          <stop offset="1" stopColor="#bfdbfe" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="wfGlowRight" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1030 120) rotate(20) scale(420 280)">
          <stop offset="0" stopColor="#dbeafe" stopOpacity="0.5" />
          <stop offset="1" stopColor="#dbeafe" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="wfFlowLine" x1="120" y1="0" x2="1080" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="0.5" stopColor="#2563eb" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
        <linearGradient id="wfActiveCard" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#f5f9ff" />
        </linearGradient>
        <linearGradient id="wfIconBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#1d6ef5" />
        </linearGradient>
        <filter id="wfCardShadow" x="-12%" y="-10%" width="124%" height="128%">
          <feDropShadow dx="0" dy="10" stdDeviation="14" floodColor="#1e3a8a" floodOpacity="0.06" />
        </filter>
        <filter id="wfPillShadow" x="-15%" y="-15%" width="130%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#1d4ed8" floodOpacity="0.08" />
        </filter>
      </defs>

      {/* Canvas backdrop */}
      <rect width="1200" height="660" fill="url(#wfCanvasGrad)" />
      <rect width="1200" height="660" fill="url(#wfGlowLeft)" />
      <rect width="1200" height="660" fill="url(#wfGlowRight)" />

      {/* Top minimal header strip */}
      <rect x="44" y="34" width="236" height="34" rx="17" fill="#ffffff" stroke="#d5e4fa" strokeWidth="1" />
      <circle cx="64" cy="51" r="4.5" fill="#1d6ef5" />
      <text x="78" y="56" fill="#1e3a8a" fontSize="13.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">
        科研全流程 · 从 Idea 到 Paper
      </text>

      <text x="1156" y="56" textAnchor="end" fill="#64748b" fontSize="13" fontWeight="500" fontFamily="PingFang SC, -apple-system, sans-serif">
        5 大阶段 · 23 项科研能力 · 支持任意环节切入
      </text>

      {/* Main horizontal spine behind stage cards */}
      <path d="M 145 152 L 1055 152" stroke="#dbeafe" strokeWidth="4" strokeLinecap="round" />
      <path className="wf-flow-dash" d="M 145 152 L 1055 152" stroke="url(#wfFlowLine)" strokeWidth="2.5" strokeDasharray="8 8" strokeLinecap="round" />

      {/* Directional chevron connectors between the 5 stages */}
      {[261, 487, 713, 939].map((cx) => (
        <g key={cx} transform={`translate(${cx}, 152)`}>
          <circle cx="0" cy="0" r="12" fill="#ffffff" stroke="#bfdbfe" strokeWidth="1.5" />
          <path d="M -3 -4.5 L 2.5 0 L -3 4.5" stroke="#1d6ef5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ))}

      {/* Stage 01: 发现与理解 */}
      <g transform="translate(44, 96)">
      <g className="wf-stage-group">
        <rect width="204" height="444" rx="22" fill="url(#wfActiveCard)" stroke="#d6e4f8" strokeWidth="1.2" filter="url(#wfCardShadow)" />
        <rect x="16" y="18" width="44" height="44" rx="13" fill="url(#wfIconBg)" />
        <g transform="translate(27, 29)" stroke="#ffffff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="10" cy="10" r="6.5" />
          <path d="M 15 15 L 20 20" />
        </g>
        <text x="72" y="34" fill="#3b82f6" fontSize="11.5" fontWeight="700" letterSpacing="0.8" fontFamily="Inter, sans-serif">STAGE 01</text>
        <text x="72" y="56" fill="#151823" fontSize="17" fontWeight="700" fontFamily="PingFang SC, -apple-system, sans-serif">发现与理解</text>
        <text x="16" y="86" fill="#64748b" fontSize="12.5" fontFamily="PingFang SC, -apple-system, sans-serif">梳理文献脉络，建立研究认知</text>
        <line x1="16" y1="104" x2="188" y2="104" stroke="#edf2fa" strokeWidth="1" />

        {/* Vertical sub-flow line */}
        <line x1="34" y1="132" x2="34" y2="368" stroke="#dbeafe" strokeWidth="2" strokeLinecap="round" />
        {[
          { y: 122, t: "论文发现", s: "多学术库检索去重" },
          { y: 180, t: "论文精读", s: "拆解方法与假设边界" },
          { y: 238, t: "跨论文问答", s: "对齐多篇结论差异" },
          { y: 296, t: "文献综述", s: "沉淀证据矩阵与空白" },
          { y: 354, t: "研究地图", s: "定位领域分支与演进" },
        ].map((step, i) => (
          <g key={step.t} transform={`translate(16, ${step.y})`}>
            <rect width="172" height="46" rx="12" fill={i === 0 ? "var(--landing-palette-26)" : "var(--landing-panorama-bg)"} stroke={i === 0 ? "var(--landing-panorama-chip-active-border)" : "var(--landing-panorama-border)"} strokeWidth="1" />
            <circle cx="18" cy="23" r="5" fill={i === 0 ? "var(--landing-palette-3)" : "var(--landing-palette-19)"} />
            <text x="32" y="21" fill="#172438" fontSize="13.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">{step.t}</text>
            <text x="32" y="37" fill="#64748b" fontSize="11" fontFamily="PingFang SC, -apple-system, sans-serif">{step.s}</text>
          </g>
        ))}
        <text x="102" y="424" textAnchor="middle" fill="#2563eb" fontSize="11.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">
          产出：有来源的研究认知
        </text>
      </g>
      </g>

      {/* Stage 02: 构思与定义 */}
      <g transform="translate(270, 96)">
      <g className="wf-stage-group">
        <rect width="204" height="444" rx="22" fill="url(#wfActiveCard)" stroke="#d6e4f8" strokeWidth="1.2" filter="url(#wfCardShadow)" />
        <rect x="16" y="18" width="44" height="44" rx="13" fill="url(#wfIconBg)" />
        <g transform="translate(27, 29)" stroke="#ffffff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 11 3 A 6 6 0 0 1 15 13.5 C 14 14.5 13.5 15.5 13.5 17 H 8.5 C 8.5 15.5 8 14.5 7 13.5 A 6 6 0 0 1 11 3 Z" />
          <line x1="9" y1="20" x2="13" y2="20" />
        </g>
        <text x="72" y="34" fill="#3b82f6" fontSize="11.5" fontWeight="700" letterSpacing="0.8" fontFamily="Inter, sans-serif">STAGE 02</text>
        <text x="72" y="56" fill="#151823" fontSize="17" fontWeight="700" fontFamily="PingFang SC, -apple-system, sans-serif">构思与定义</text>
        <text x="16" y="86" fill="#64748b" fontSize="12.5" fontFamily="PingFang SC, -apple-system, sans-serif">凝练问题，形成可验证假设</text>
        <line x1="16" y1="104" x2="188" y2="104" stroke="#edf2fa" strokeWidth="1" />

        <line x1="34" y1="138" x2="34" y2="352" stroke="#dbeafe" strokeWidth="2" strokeLinecap="round" />
        {[
          { y: 128, t: "Idea 澄清", s: "界定研究对象与价值" },
          { y: 196, t: "新颖性检查", s: "对比近似工作定位增量" },
          { y: 264, t: "假设形成", s: "转化为可证伪命题" },
          { y: 332, t: "研究问题定义", s: "锁定输入输出与边界" },
        ].map((step, i) => (
          <g key={step.t} transform={`translate(16, ${step.y})`}>
            <rect width="172" height="52" rx="12" fill={i === 0 ? "var(--landing-palette-26)" : "var(--landing-panorama-bg)"} stroke={i === 0 ? "var(--landing-panorama-chip-active-border)" : "var(--landing-panorama-border)"} strokeWidth="1" />
            <circle cx="18" cy="26" r="5" fill={i === 0 ? "var(--landing-palette-3)" : "var(--landing-palette-19)"} />
            <text x="32" y="23" fill="#172438" fontSize="13.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">{step.t}</text>
            <text x="32" y="40" fill="#64748b" fontSize="11" fontFamily="PingFang SC, -apple-system, sans-serif">{step.s}</text>
          </g>
        ))}
        <text x="102" y="424" textAnchor="middle" fill="#2563eb" fontSize="11.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">
          产出：清晰可检验的假设
        </text>
      </g>
      </g>

      {/* Stage 03: 方法与实验设计 */}
      <g transform="translate(496, 96)">
      <g className="wf-stage-group">
        <rect width="204" height="444" rx="22" fill="url(#wfActiveCard)" stroke="#d6e4f8" strokeWidth="1.2" filter="url(#wfCardShadow)" />
        <rect x="16" y="18" width="44" height="44" rx="13" fill="url(#wfIconBg)" />
        <g transform="translate(27, 29)" stroke="#ffffff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 8 3 H 14 M 9.5 3 V 8.5 L 5 17.5 C 4.4 18.7 5.2 20 6.5 20 H 15.5 C 16.8 20 17.6 18.7 17 17.5 L 12.5 8.5 V 3" />
        </g>
        <text x="72" y="34" fill="#3b82f6" fontSize="11.5" fontWeight="700" letterSpacing="0.8" fontFamily="Inter, sans-serif">STAGE 03</text>
        <text x="72" y="56" fill="#151823" fontSize="17" fontWeight="700" fontFamily="PingFang SC, -apple-system, sans-serif">方法与实验设计</text>
        <text x="16" y="86" fill="#64748b" fontSize="12.5" fontFamily="PingFang SC, -apple-system, sans-serif">冻结指标基线，编排实验路线</text>
        <line x1="16" y1="104" x2="188" y2="104" stroke="#edf2fa" strokeWidth="1" />

        <line x1="34" y1="138" x2="34" y2="352" stroke="#dbeafe" strokeWidth="2" strokeLinecap="round" />
        {[
          { y: 128, t: "方法设计", s: "设计核心算法与路线" },
          { y: 196, t: "实验设计", s: "设置对照、消融与重复" },
          { y: 264, t: "指标与基线", s: "冻结评价协议与标准" },
          { y: 332, t: "资源可行性", s: "评估算力与数据预算" },
        ].map((step, i) => (
          <g key={step.t} transform={`translate(16, ${step.y})`}>
            <rect width="172" height="52" rx="12" fill={i === 0 ? "var(--landing-palette-26)" : "var(--landing-panorama-bg)"} stroke={i === 0 ? "var(--landing-panorama-chip-active-border)" : "var(--landing-panorama-border)"} strokeWidth="1" />
            <circle cx="18" cy="26" r="5" fill={i === 0 ? "var(--landing-palette-3)" : "var(--landing-palette-19)"} />
            <text x="32" y="23" fill="#172438" fontSize="13.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">{step.t}</text>
            <text x="32" y="40" fill="#64748b" fontSize="11" fontFamily="PingFang SC, -apple-system, sans-serif">{step.s}</text>
          </g>
        ))}
        <text x="102" y="424" textAnchor="middle" fill="#2563eb" fontSize="11.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">
          产出：可冻结的实验方案
        </text>
      </g>
      </g>

      {/* Stage 04: 实现与验证 */}
      <g transform="translate(722, 96)">
      <g className="wf-stage-group">
        <rect width="204" height="444" rx="22" fill="url(#wfActiveCard)" stroke="#d6e4f8" strokeWidth="1.2" filter="url(#wfCardShadow)" />
        <rect x="16" y="18" width="44" height="44" rx="13" fill="url(#wfIconBg)" />
        <g transform="translate(27, 29)" stroke="#ffffff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="18" height="14" rx="3" />
          <path d="M 7.5 8.5 L 5.5 10.5 L 7.5 12.5 M 14.5 8.5 L 16.5 10.5 L 14.5 12.5 M 11.5 7.5 L 10.5 13.5" />
        </g>
        <text x="72" y="34" fill="#3b82f6" fontSize="11.5" fontWeight="700" letterSpacing="0.8" fontFamily="Inter, sans-serif">STAGE 04</text>
        <text x="72" y="56" fill="#151823" fontSize="17" fontWeight="700" fontFamily="PingFang SC, -apple-system, sans-serif">实现与验证</text>
        <text x="16" y="86" fill="#64748b" fontSize="12.5" fontFamily="PingFang SC, -apple-system, sans-serif">沙箱跑批实验，留存真实日志</text>
        <line x1="16" y1="104" x2="188" y2="104" stroke="#edf2fa" strokeWidth="1" />

        <line x1="34" y1="132" x2="34" y2="368" stroke="#dbeafe" strokeWidth="2" strokeLinecap="round" />
        {[
          { y: 122, t: "代码与数据接管", s: "解析现有项目建立基线" },
          { y: 180, t: "论文复现", s: "对照原文逐项复跑" },
          { y: 238, t: "环境构建", s: "锁定依赖与随机种子" },
          { y: 296, t: "实验执行", s: "受控调度记录全部产物" },
          { y: 354, t: "失败诊断", s: "定位故障分层修复重跑" },
        ].map((step, i) => (
          <g key={step.t} transform={`translate(16, ${step.y})`}>
            <rect width="172" height="46" rx="12" fill={i === 0 ? "var(--landing-palette-26)" : "var(--landing-panorama-bg)"} stroke={i === 0 ? "var(--landing-panorama-chip-active-border)" : "var(--landing-panorama-border)"} strokeWidth="1" />
            <circle cx="18" cy="23" r="5" fill={i === 0 ? "var(--landing-palette-3)" : "var(--landing-palette-19)"} />
            <text x="32" y="21" fill="#172438" fontSize="13.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">{step.t}</text>
            <text x="32" y="37" fill="#64748b" fontSize="11" fontFamily="PingFang SC, -apple-system, sans-serif">{step.s}</text>
          </g>
        ))}
        <text x="102" y="424" textAnchor="middle" fill="#2563eb" fontSize="11.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">
          产出：代码与可核验运行记录
        </text>
      </g>
      </g>

      {/* Stage 05: 分析与表达 */}
      <g transform="translate(948, 96)">
      <g className="wf-stage-group">
        <rect width="208" height="444" rx="22" fill="url(#wfActiveCard)" stroke="#d6e4f8" strokeWidth="1.2" filter="url(#wfCardShadow)" />
        <rect x="16" y="18" width="44" height="44" rx="13" fill="url(#wfIconBg)" />
        <g transform="translate(27, 29)" stroke="#ffffff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 4 17 L 9 12 L 13 15 L 19 8" />
          <path d="M 15 8 H 19 V 12" />
        </g>
        <text x="72" y="34" fill="#3b82f6" fontSize="11.5" fontWeight="700" letterSpacing="0.8" fontFamily="Inter, sans-serif">STAGE 05</text>
        <text x="72" y="56" fill="#151823" fontSize="17" fontWeight="700" fontFamily="PingFang SC, -apple-system, sans-serif">分析与表达</text>
        <text x="16" y="86" fill="#64748b" fontSize="12.5" fontFamily="PingFang SC, -apple-system, sans-serif">实测绘图写作，双审归档交付</text>
        <line x1="16" y1="104" x2="192" y2="104" stroke="#edf2fa" strokeWidth="1" />

        <line x1="34" y1="132" x2="34" y2="368" stroke="#dbeafe" strokeWidth="2" strokeLinecap="round" />
        {[
          { y: 122, t: "结果分析", s: "统计检验与不确定性评估" },
          { y: 180, t: "科研绘图", s: "图表与原始数据同源绑定" },
          { y: 238, t: "论文写作", s: "关键主张直达实验证据" },
          { y: 296, t: "引用核验", s: "逐条审计文献与数值一致" },
          { y: 354, t: "模拟审稿", s: "独立评审并归档研究包" },
        ].map((step, i) => (
          <g key={step.t} transform={`translate(16, ${step.y})`}>
            <rect width="176" height="46" rx="12" fill={i === 0 ? "var(--landing-palette-26)" : "var(--landing-panorama-bg)"} stroke={i === 0 ? "var(--landing-panorama-chip-active-border)" : "var(--landing-panorama-border)"} strokeWidth="1" />
            <circle cx="18" cy="23" r="5" fill={i === 0 ? "var(--landing-palette-3)" : "var(--landing-palette-19)"} />
            <text x="32" y="21" fill="#172438" fontSize="13.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">{step.t}</text>
            <text x="32" y="37" fill="#64748b" fontSize="11" fontFamily="PingFang SC, -apple-system, sans-serif">{step.s}</text>
          </g>
        ))}
        <text x="104" y="424" textAnchor="middle" fill="#2563eb" fontSize="11.5" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">
          产出：可审阅论文与研究包
        </text>
      </g>
      </g>

      {/* Bottom feedback & human-gate return loop */}
      <path
        d="M 1052 542 C 1052 586, 980 598, 910 598 L 440 598 C 390 598, 372 576, 372 548"
        stroke="#93c5fd"
        strokeWidth="2"
        strokeDasharray="6 6"
        strokeLinecap="round"
      />
      <path d="M 366 556 L 372 544 L 378 556" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

      <g transform="translate(465, 578)" filter="url(#wfPillShadow)">
        <rect width="410" height="40" rx="20" fill="#ffffff" stroke="#cde0fa" strokeWidth="1.2" />
        <circle cx="22" cy="20" r="4.5" fill="#1d6ef5" />
        <text x="36" y="25" fill="#1e3a8a" fontSize="13" fontWeight="600" fontFamily="PingFang SC, -apple-system, sans-serif">
          实验反馈与审稿修订闭环 · G1–G4 关键节点人工确认
        </text>
      </g>
    </svg>
  );
}

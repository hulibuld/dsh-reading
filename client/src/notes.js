/**
 * notes.js —— 「读书笔记」侧栏：把这本书的笔记写进 Obsidian 库。
 *
 * 它做的事（和它故意不做的事）：
 *
 *   · **做**：把宿主已经算好的两份笔记落成一个文件夹里的两个 Markdown——
 *     「00 全书地图」和「01 读书笔记」，逐章分小节，把蒸馏要点、我的划线批注、
 *     问 AI 的讨论记录按章归位；已经写过的块跳过，重复同步不产生任何改动。
 *   · **不做**：不在浏览器里拼 Markdown。组块、核对指纹、判断「这段是用户自己改的」
 *     全在宿主侧（lib/notesync.js），这里只负责把结果说人话、给按钮。
 *   · **硬规矩**：块外面的内容是用户的地盘，我们一个字都不碰；块里面用户改过就
 *     不覆盖、只在侧栏说「有 N 处你改过，没动」。笔记不是发布物，宁可少写不能写错。
 *
 * 空态是有意义的：没配库时不该假装功能存在，直接说「去设置里选一个库」。
 */

/** 「00 全书地图 / 01 读书笔记」这类条目的中文名。 */
const KIND_LABEL = {
  map: '全书地图',
  note: '读书笔记',
  relations: '人物关系',
}

/** 一份文件的状态文案：「还没生成」「已同步 · 12 个块」。 */
export function fileStatusText(item) {
  if (!item || typeof item !== 'object') return { text: '没同步', tone: 'idle' }
  const blocks = Number.isFinite(item.blocks) ? item.blocks : 0
  if (item.exists !== true) return { text: '还没生成', tone: 'idle' }
  if (blocks === 0) return { text: '空文件', tone: 'idle' }
  const written = Number.isFinite(item.written) ? item.written : 0
  if (written < blocks) return { text: '写过 ' + written + ' / ' + blocks + ' 块', tone: 'idle' }
  return { text: '已同步 · ' + blocks + ' 个块', tone: 'ok' }
}

/**
 * 在 Obsidian 里打开某个文件的 URL。
 *
 * 宿主侧 notes.sync 也会回一份同样的 openUrl；这里再算一次是为了「已经同步过、
 * 只想打开看看」也能用，不必为了拿个链接去重跑一次同步。
 * vault 参数是库根目录的绝对路径，Obsidian 的 vault 名就是它最后一段。
 */
export function obsidianUrl(vault, relPath) {
  const root = String(vault || '').replace(/[\\/]+$/, '')
  const name = root.split(/[\\/]/).pop() || ''
  const file = String(relPath || '')
  if (name === '' || file === '') return ''
  return 'obsidian://open?vault=' + encodeURIComponent(name) + '&file=' + encodeURIComponent(file)
}

/** 一句话概括这本书的笔记现状，给侧栏头用。 */
export function notesSummary(status) {
  const items = status && Array.isArray(status.items) ? status.items : []
  const ready = items.filter((item) => item && item.exists === true)
  const total = items.reduce((sum, item) => sum + (Number.isFinite(item && item.blocks) ? item.blocks : 0), 0)
  const written = items.reduce((sum, item) => sum + (Number.isFinite(item && item.written) ? item.written : 0), 0)
  return {
    configured: !!(status && status.configured),
    files: items.length,
    ready: ready.length,
    blocks: total,
    written,
    pending: Math.max(0, total - written),
    conflicted: Number.isFinite(status && status.conflicted) ? status.conflicted : 0,
    skippedQa: Number.isFinite(status && status.skippedQa) ? status.skippedQa : 0,
  }
}

/** 上次同步时间的相对说法。时间戳读不出来就原样不显示，别显示 NaN。 */
export function syncedText(iso) {
  if (typeof iso !== 'string' || iso === '') return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 0) return '刚刚'
  const minute = 60 * 1000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return Math.floor(diff / minute) + ' 分钟前'
  if (diff < 24 * 60 * minute) return Math.floor(diff / (60 * minute)) + ' 小时前'
  if (diff < 30 * 24 * 60 * minute) return Math.floor(diff / (24 * 60 * minute)) + ' 天前'
  return iso.slice(0, 10)
}

/**
 * 「这条问答写进 Obsidian 了吗」——问 AI 面板底下一句话（L0 自动归位）。
 *
 * 宿主在 qa.ask 的返回里塞了 obsidian 字段：写完是 {written, files, ...}，
 * 没开/没配是 {skipped:true, reason}，出错是 {error}。三种都不该阻断问答，
 * 所以这里只负责说人话：
 *
 *   · 没开这个功能、没选库 —— 一个字都不说。用户没开的功能不该每次问完都提醒；
 *   · 写进去了 —— 说写了，并且手改过的段落要交代清楚（没动就是没动）；
 *   · 出错 —— 原样带上宿主给的短句，别吞掉原因，也别吓唬人。
 */
export function autowriteText(obsidian) {
  if (!obsidian || typeof obsidian !== 'object') return ''
  const error = typeof obsidian.error === 'string' ? obsidian.error.trim() : ''
  if (error !== '') return '这条没写进 Obsidian：' + error
  if (obsidian.skipped === true) return ''
  const written = Number.isFinite(obsidian.written) ? obsidian.written : 0
  const conflicts = Number.isFinite(obsidian.conflicts) ? obsidian.conflicts : 0
  if (written > 0) {
    return conflicts > 0
      ? '已写进 Obsidian 的读书笔记（' + conflicts + ' 处你改过，没动）'
      : '已写进 Obsidian 的读书笔记'
  }
  if (conflicts > 0) return '这条对应的段落你改过，没动它'
  return 'Obsidian 里的读书笔记已经是最新的'
}

/**
 * 「这位读者」那两行字（docs/26 §6.4）。
 *
 * 三条规矩，全都来自「用户是 IT 小白」这一条：
 *   · 不解释「什么是画像」，只说这本书问过什么、因此笔记会怎么写；
 *   · 没问过就说「还没问过」，绝不显示「0 个问题」；
 *   · 关掉个性化时整段不出现 —— 用户关掉的功能不该在界面上继续占位置。
 *
 * @returns {{head:string, tail:string, empty:boolean} | null}
 */
export function profileText(state) {
  if (!state || typeof state !== 'object') return null
  if (state.enabled === false) return null
  const asked = Number.isFinite(state.askedCount) ? state.askedCount : 0
  if (asked <= 0) {
    return { head: '还没问过这本书', tail: '问过几句之后，笔记会自动照着你的问法写。', empty: true }
  }
  const sentence = state.sentence && typeof state.sentence === 'object' ? state.sentence : null
  const head = sentence && typeof sentence.head === 'string' ? sentence.head : '这本书你问过 ' + asked + ' 个问题。'
  const tail = sentence && typeof sentence.tail === 'string' ? sentence.tail : ''
  return { head, tail, empty: false }
}

/**
 * 画像卡片：两行字 + 两个按钮。
 *
 * 「重新分析」是 docs/26 §6.5 的第三条对策：画像会自我强化，用户需要一个
 * 「我不认同，重来一遍」的出口，而不是只能删文件。
 * 「关掉」直接改设置，改完这张卡就消失 —— 不做二次确认，因为它随时能开回来。
 */
function ProfileCard(props) {
  const view = profileText(props.profile)
  if (!view) return null
  const busy = props.profileBusy === true
  return h(
    'div',
    { className: 'dr-profile dr-profile-' + (view.empty ? 'empty' : 'ready') },
    h('div', { className: 'dr-profile-head' },
      h('span', { className: 'dr-profile-title' }, '这本书你问过什么'),
      h('div', { className: 'dr-grow' }),
      h('button', {
        type: 'button',
        className: 'dr-linkbtn',
        disabled: busy,
        title: '按现在的问答记录重新算一遍',
        onClick: typeof props.onProfileRebuild === 'function' ? () => props.onProfileRebuild() : undefined,
      }, busy ? '重算中…' : '重新分析'),
      h('button', {
        type: 'button',
        className: 'dr-linkbtn',
        disabled: busy,
        title: '关掉之后，笔记按通用口径写',
        onClick: typeof props.onProfileOff === 'function' ? () => props.onProfileOff() : undefined,
      }, '关掉')),
    h('div', { className: 'dr-profile-line' }, view.head),
    view.tail !== '' ? h('div', { className: 'dr-profile-sub' }, view.tail) : null,
  )
}

function FileRow(item, props) {
  const kind = item && typeof item.kind === 'string' ? item.kind : ''
  const label = KIND_LABEL[kind] || kind || '笔记'
  const status = fileStatusText(item)
  const relPath = item && typeof item.relPath === 'string' ? item.relPath : ''
  const synced = item ? syncedText(item.syncedAt) : ''
  const busy = typeof props.busy === 'string' && props.busy !== ''
  return h(
    'div',
    { key: kind, className: 'dr-notes-row dr-notes-row-' + status.tone },
    h('div',
      { className: 'dr-notes-row-head' },
      h('span', { className: 'dr-notes-row-label', title: relPath }, label),
      h('span', { className: 'dr-notes-badge' }, status.text)),
    h('div', { className: 'dr-notes-path', title: relPath }, relPath),
    h('div', { className: 'dr-notes-row-foot' },
      synced !== '' ? h('span', { className: 'dr-notes-time' }, '上次写：' + synced) : null,
      h('div', { className: 'dr-grow' }),
      item && item.exists === true
        ? h('button', {
          type: 'button',
          className: 'dr-btn dr-btn-sm dr-btn-quiet',
          disabled: busy,
          title: '在 Obsidian 里打开这份笔记',
          onClick: typeof props.onOpen === 'function' ? () => props.onOpen(kind) : undefined,
        }, '在 Obsidian 打开')
        : null,
      h('button', {
        type: 'button',
        className: 'dr-btn dr-btn-sm dr-btn-quiet',
        disabled: busy,
        title: '只看会写成什么，不落盘',
        onClick: typeof props.onPreview === 'function' ? () => props.onPreview(kind) : undefined,
      }, '预览'),
      h('button', {
        type: 'button',
        className: 'dr-btn dr-btn-sm',
        disabled: busy,
        title: '把这一份写进 Obsidian 库（已有的块会跳过）',
        onClick: typeof props.onSync === 'function' ? () => props.onSync([kind]) : undefined,
      }, busy === kind ? '写入中…' : '写入')));
}

/**
 * 「人物关系」卡片（0.13.0 P5）。
 *
 * 这一段存在的理由：抽人物关系是这本书里唯一**要跑好几批**的动作，
 * 用户看不到进度就会以为卡死，然后反复点。所以这里三样都要有：
 * 现在跑到哪、这一批抽到几条、还剩几批。
 */
function RelationsCard(props) {
  const state = props.relations && typeof props.relations === 'object' ? props.relations : null
  if (!state) return null
  const action = relationsActionText(state)
  const busy = props.busy === true
  const progress = state.progress && typeof state.progress === 'object' ? state.progress : {}
  const total = Number.isFinite(progress.total) ? progress.total : 0
  const done = Number.isFinite(progress.done) ? progress.done : 0
  const failed = Number.isFinite(progress.failed) ? progress.failed : 0
  const persons = Array.isArray(state.persons) ? state.persons : []
  const edges = Array.isArray(state.edges) ? state.edges : []
  const names = persons.slice(0, 8).map((item) => String(item && item.name ? item.name : '')).filter((name) => name !== '')

  // 一句话交代它是怎么来的。不解释算法，只说「每条都要在原文里找到那句话」——
  // 用户信不过的从来不是模型慢，是怕它编。
  const hint = total === 0
    ? '只在小说上做：看前 ' + (Number.isFinite(state.sourceChapters) ? state.sourceChapters : 24) + ' 章里的人名和关系，每条都必须在原文里找到对应那句话。'
    : '已跑 ' + (done + failed) + ' / ' + total + ' 批'
      + (Number.isFinite(progress.dropped) && progress.dropped > 0 ? '，丢掉 ' + progress.dropped + ' 条原句核不上的' : '')
      + '。'
  const notice = typeof props.notice === 'string' ? props.notice : ''

  return h(
    'div',
    { className: 'dr-profile dr-relations' },
    h('div', { className: 'dr-profile-head' },
      h('span', { className: 'dr-profile-title' }, '人物关系'),
      h('div', { className: 'dr-grow' }),
      total > 0 || edges.length > 0
        ? h('span', { className: 'dr-head-sub' }, persons.length + ' 人 · ' + edges.length + ' 条')
        : null),
    h('div', { className: 'dr-profile-line' }, hint),
    names.length > 0
      ? h('div', { className: 'dr-profile-sub' }, names.join('、') + (persons.length > names.length ? ' 等' : ''))
      : null,
    notice !== '' ? h('div', { className: 'dr-notes-notice' }, notice) : null,
    action.why !== '' ? h('div', { className: 'dr-profile-sub' }, action.why) : null,
    h('div', { className: 'dr-notes-actions' },
      h('button', {
        type: 'button',
        className: 'dr-btn dr-btn-sm dr-btn-primary',
        disabled: busy || action.disabled === true,
        title: '一批一批抽，每批都会回原文核对',
        onClick: typeof props.onBuild === 'function' ? () => props.onBuild() : undefined,
      }, busy ? '抽这一批…' : action.text),
      total > 0
        ? h('button', {
          type: 'button',
          className: 'dr-btn dr-btn-sm dr-btn-quiet',
          disabled: busy,
          title: '清空重来（已抽到的人名和关系都会丢掉）',
          onClick: typeof props.onClear === 'function' ? () => props.onClear() : undefined,
        }, '清空')
        : null,
      total > 0 && typeof props.onSync === 'function'
        ? h('button', {
          type: 'button',
          className: 'dr-btn dr-btn-sm dr-btn-quiet',
          disabled: busy || typeof props.busyKind === 'string' && props.busyKind !== '',
          title: '把关系图写进 Obsidian（02 人物关系）',
          onClick: () => props.onSync(['relations']),
        }, '写进笔记')
        : null),
  )
}

/**
 * 「跨书主题」卡片（0.13.0 P5 第二半）。
 *
 * 门槛是高的、候选是少的，这是故意的：误报一个主题页，用户下次就不看了。
 * 所以这里连「为什么只有这么几条」都不解释——列表短本身就是答案。
 */
function ThreadsCard(props) {
  const data = props.threads && typeof props.threads === 'object' ? props.threads : null
  if (!data) return null
  const candidates = Array.isArray(data.candidates) ? data.candidates : []
  const standing = Array.isArray(data.standing) ? data.standing : []
  const scanned = data.scanned && typeof data.scanned === 'object' ? data.scanned : {}
  const busy = typeof props.busy === 'string' ? props.busy : ''
  const notice = typeof props.notice === 'string' ? props.notice : ''
  const vaultError = typeof data.vaultError === 'string' ? data.vaultError : ''

  return h(
    'div',
    { className: 'dr-profile dr-threads' },
    h('div', { className: 'dr-profile-head' },
      h('span', { className: 'dr-profile-title' }, '跨书主题'),
      h('div', { className: 'dr-grow' }),
      h('span', { className: 'dr-head-sub' },
        (Number.isFinite(scanned.books) ? scanned.books : 0) + ' 本 · '
        + (Number.isFinite(scanned.blocks) ? scanned.blocks : 0) + ' 段讨论')),
    h('div', { className: 'dr-profile-line' },
      candidates.length === 0
        ? '同一件事在两本书里都问过，才会出现在这里。现在还没有。'
        : '这些词在两本书以上都出现过。立成主题会建一页，把各本书里的说法并排放。'),
    vaultError !== '' ? h('div', { className: 'dr-notes-warn' }, vaultError) : null,
    notice !== '' ? h('div', { className: 'dr-notes-notice' }, notice) : null,
    standing.length > 0
      ? h('div', { className: 'dr-notes-row-foot' },
        h('span', { className: 'dr-notes-time' }, '已立 ' + standing.length + ' 个主题'),
        h('div', { className: 'dr-grow' }),
        typeof props.onOpenIndex === 'function'
          ? h('button', {
            type: 'button',
            className: 'dr-btn dr-btn-sm dr-btn-quiet',
            title: '在 Obsidian 里打开主题总览',
            onClick: () => props.onOpenIndex(),
          }, '看总览')
          : null)
      : null,
    candidates.length > 0
      ? h('div', { className: 'dr-notes-list' }, candidates.map((item) => {
        const term = String(item && item.term ? item.term : '')
        const already = item && item.already === true
        return h('div', { key: term, className: 'dr-notes-row dr-notes-row-ok' },
          h('div', { className: 'dr-notes-row-head' },
            h('span', { className: 'dr-notes-row-label' }, term),
            already ? h('span', { className: 'dr-notes-badge' }, '已立') : null),
          h('div', { className: 'dr-notes-path' }, candidateText(item)),
          h('div', { className: 'dr-notes-row-foot' },
            h('div', { className: 'dr-grow' }),
            h('button', {
              type: 'button',
              className: 'dr-btn dr-btn-sm' + (already ? ' dr-btn-quiet' : ''),
              disabled: busy !== '' || data.configured !== true,
              title: data.configured === true ? '建一页主题笔记' : '先去设置里选 Obsidian 库',
              onClick: typeof props.onBuild === 'function' ? () => props.onBuild(term) : undefined,
            }, busy === term ? '写着…' : already ? '更新' : '立成主题'))
        )
      }))
      : null,
  )
}
/**
 * 「我写过什么」卡片（0.13.0 P6）。
 *
 * 这一张跟上面几张不同：上面都是「程序要写给你什么」，这一张是**你自己**在 Obsidian
 * 里已经攒下的东西。所以：
 *   · 一个字都不改、一个按钮都不给写 —— 只列文件名与一二级小标题，点一下在 Obsidian 里打开；
 *   · 没有页就不出现 —— 面板下面那份「还没生成」的清单已经说了这件事，再说一遍是噪音；
 *   · 程序写的 `## 第三章` 不算你写的 —— 每行带 `own`，只有自己写的标题才计入「N 条」。
 *
 * 只读标题这件事是硬约束（docs/26 §十末尾）：正文既没有从宿主传过来，也没有地方存，
 * 所以这里不可能「顺手把笔记喂给模型」。
 */

/** 一页最多先摊开几条小标题；再多就折起来，侧栏会变成一堵墙。 */
const MINE_HEADING_LIMIT = 6

function MyNotesRow(file, props) {
  const name = String(file && file.name ? file.name : '')
  const headings = Array.isArray(file && file.headings) ? file.headings : []
  const ownCount = Number.isFinite(file && file.ownCount) ? file.ownCount : 0
  const shown = headings.slice(0, MINE_HEADING_LIMIT)
  const rest = headings.length - shown.length
  const openUrl = typeof (file && file.openUrl) === 'string' && file.openUrl !== ''
    ? file.openUrl
    : obsidianUrl(props.vault, file && file.relPath)
  return h('div', { key: file && file.relPath ? file.relPath : name, className: 'dr-notes-row dr-notes-row-ok' },
    h('div', { className: 'dr-notes-row-head' },
      h('span', { className: 'dr-notes-row-label', title: String(file && file.relPath ? file.relPath : '') }, name),
      ownCount > 0 ? h('span', { className: 'dr-notes-badge' }, ownCount + ' 条') : null),
    shown.length > 0
      ? h('div', { className: 'dr-notes-path' }, shown.map((item) => {
        // 程序写的小节用「·」标出来：不解释，但一眼能看出哪几行是自己起的标题。
        const text = (item && item.own === false ? '· ' : '') + String(item && item.text ? item.text : '')
        return h('div', { key: String(item && item.line) + text }, text)
      }))
      : h('div', { className: 'dr-notes-path' }, '这一页没有小标题。'),
    rest > 0 ? h('div', { className: 'dr-notes-path' }, '还有 ' + rest + ' 条…') : null,
    h('div', { className: 'dr-notes-row-foot' },
      h('div', { className: 'dr-grow' }),
      openUrl !== ''
        ? h('a', {
          className: 'dr-linkbtn',
          href: openUrl,
          title: '在 Obsidian 里打开这一页',
          rel: 'noreferrer',
        }, '打开')
        : null),
  )
}

/**
 * 卡片本体。
 *
 * @param {object} props
 * @param {object|null} props.mine  notes.mine 的返回
 */
export function MyNotesCard(props) {
  const data = props.mine && typeof props.mine === 'object' ? props.mine : null
  if (!data) return null
  if (data.configured !== true) return null
  const files = Array.isArray(data.files) ? data.files : []
  const vaultError = typeof data.vaultError === 'string' ? data.vaultError : ''
  // 库打不开时上面那张 warn 已经说过了，这里不重复；没有页就整张不出现。
  if (files.length === 0) return null
  const skipped = Number.isFinite(data.skipped) ? data.skipped : 0
  const total = files.reduce((sum, file) => sum + (Number.isFinite(file && file.ownCount) ? file.ownCount : 0), 0)

  return h('div', { className: 'dr-profile dr-mine' },
    h('div', { className: 'dr-profile-head' },
      h('span', { className: 'dr-profile-title' }, '我写过什么'),
      h('div', { className: 'dr-grow' }),
      h('span', { className: 'dr-head-sub' }, files.length + ' 页 · ' + total + ' 条标题')),
    h('div', { className: 'dr-profile-line' },
      '这个文件夹里已经有这些页。我只读标题，正文一个字都不碰。'),
    h('div', { className: 'dr-notes-list' }, files.map((file) => MyNotesRow(file, { vault: data.vault }))),
    skipped > 0
      ? h('div', { className: 'dr-notes-pending' }, '这个文件夹里还有 ' + skipped + ' 页没列出来——先列前面这些。')
      : null,
  )
}
/**
 * 面板本体。
 *
 * @param {object} props
 * @param {object|null} props.status    notes.status 的返回
 * @param {boolean} props.loading
 * @param {string}  props.error
 * @param {string}  props.busy          正在写的那一类（'map' / 'note' / 'all'）
 * @param {string}  props.notice        一句成功提示（写了几块 / 全是最新的）
 * @param {object|null} props.preview   notes.preview 的返回
 * @param {object|null} props.profile   profile.get 的返回（读者画像，可能为 null）
 * @param {object|null} props.relations relations.get 的返回（人物关系，可能为 null）
 * @param {object|null} props.threads   thread.list 的返回（跨书主题，可能为 null）
 * @param {object|null} props.mine      notes.mine 的返回（我写过什么，可能为 null）
 * @param {Function} props.onMineReload  () => void  重读「我写过什么」
 * @param {boolean} props.relationsBusy 正在抽这一批
 * @param {string}  props.relationsNotice 上一批抽完的交代
 * @param {Function} props.onRelationsBuild () => void
 * @param {Function} props.onRelationsClear () => void
 * @param {Function} props.onThreadBuild (term) => void
 * @param {Function} props.onThreadReload  () => void
 * @param {Function} props.onOpenIndex    () => void  打开主题总览
 * @param {boolean} props.profileBusy   正在重算画像
 * @param {Function} props.onProfileRebuild () => void
 * @param {Function} props.onProfileOff     () => void
 * @param {Function} props.onSync       (kinds?) => void
 * @param {Function} props.onPreview    (kind) => void
 * @param {Function} props.onClosePreview
 * @param {Function} props.onOpen       (kind) => void
 * @param {Function} props.onReload
 * @param {Function} props.onOpenSettings
 */
export function NotesPanel(props) {
  const status = props.status && typeof props.status === 'object' ? props.status : null
  const summary = notesSummary(status)
  const busy = typeof props.busy === 'string' ? props.busy : ''
  const items = status && Array.isArray(status.items) ? status.items : []

  const head = h(
    'div',
    { className: 'dr-side-head' },
    h('span', null, '读书笔记'),
    h('div', { className: 'dr-grow' }),
    h('span', { className: 'dr-head-sub' },
      summary.configured ? summary.written + ' / ' + summary.blocks + ' 块' : '未连接库'))

  if (props.error) {
    return h('div', { className: 'dr-notes-panel' }, head,
      h('div', { className: 'dr-state dr-error' },
        h('div', { className: 'dr-state-title' }, '笔记面板打不开'),
        h('div', { className: 'dr-state-text' }, props.error)))
  }

  if (props.loading === true && status === null) {
    return h('div', { className: 'dr-notes-panel' }, head,
      h('div', { className: 'dr-state' },
        h('div', { className: 'dr-spinner', role: 'status', 'aria-label': '正在读取笔记状态' }),
        h('div', { className: 'dr-state-text' }, '正在读取…')))
  }

  // 没配库：功能确实还没成立，不要给一个点了会报错的按钮。
  if (status === null || summary.configured !== true) {
    return h('div', { className: 'dr-notes-panel' }, head,
      h('div', { className: 'dr-state' },
        h('div', { className: 'dr-state-title' }, '还没连上 Obsidian'),
        h('div', { className: 'dr-state-text' },
          '选一个 Obsidian 库，这本书的笔记就会写进里面的 dsh-reading 文件夹。'),
        typeof props.onOpenSettings === 'function'
          ? h('div', { className: 'dr-state-actions' },
            h('button', {
              type: 'button',
              className: 'dr-btn dr-btn-sm dr-btn-primary',
              onClick: () => props.onOpenSettings(),
            }, '去设置里选库'))
          : null))
  }

  const preview = props.preview && typeof props.preview === 'object' ? props.preview : null
  const vaultError = typeof status.vaultError === 'string' ? status.vaultError : ''

  return h(
    'div',
    { className: 'dr-notes-panel' },
    head,
    vaultError !== ''
      ? h('div', { className: 'dr-notes-warn' }, vaultError)
      : null,
    ProfileCard(props),
    // 「我写过什么」紧跟着画像：两张都在回答「这本书里的你」，
     // 一张讲你问过什么，一张讲你写过什么。
    MyNotesCard(props),
    // 两张卡各读自己的短名（onBuild / onClear / notice），这里显式搬一次：
    // 直接把 props 原样递进去，按钮会点上没反应（名字对不上）。
    RelationsCard({
      relations: props.relations,
      busy: props.relationsBusy === true,
      busyKind: busy,
      notice: props.relationsNotice,
      onBuild: props.onRelationsBuild,
      onClear: props.onRelationsClear,
      onSync: props.onSync,
    }),
    ThreadsCard({
      threads: props.threads,
      busy: props.threadBusy,
      notice: props.threadNotice,
      onBuild: props.onThreadBuild,
      onOpenIndex: props.onOpenIndex,
    }),
    h('div', { className: 'dr-notes-head' },
      h('div', { className: 'dr-notes-vault', title: status.vault },
        '库：' + String(status.vault || '') ),
      h('div', { className: 'dr-notes-actions' },
        h('button', {
          type: 'button',
          className: 'dr-btn dr-btn-sm dr-btn-primary',
          disabled: busy !== '' || vaultError !== '',
          title: '把这两份都写进 Obsidian（已有的块会跳过）',
          onClick: typeof props.onSync === 'function' ? () => props.onSync() : undefined,
        }, busy === 'all' ? '写入中…' : '全部写入'),
        h('button', {
          type: 'button',
          className: 'dr-btn dr-btn-sm',
          disabled: busy !== '' || vaultError !== '',
          title: '只重做全书地图，那个便宜',
          onClick: typeof props.onSync === 'function' ? () => props.onSync(['map']) : undefined,
        }, busy === 'map' ? '写入中…' : '只更新地图'),
        h('button', {
          type: 'button',
          className: 'dr-btn dr-btn-sm dr-btn-quiet',
          disabled: busy !== '',
          onClick: () => {
            // 刷新一起刷：状态和「我写过什么」读的是同一批文件，
             // 只刷一半会让两张卡说的话对不上。
            if (typeof props.onReload === 'function') props.onReload()
            if (typeof props.onMineReload === 'function') props.onMineReload()
          },
        }, '刷新'))),
    props.notice
      ? h('div', { className: 'dr-notes-notice' }, props.notice)
      : null,
    preview
      ? h('div', { className: 'dr-notes-preview' },
        h('div', { className: 'dr-notes-preview-head' },
          h('span', null, '预览 · ' + (KIND_LABEL[preview.kind] || preview.kind || '')),
          h('div', { className: 'dr-grow' }),
          h('button', {
            type: 'button',
            className: 'dr-btn dr-btn-sm dr-btn-quiet',
            onClick: typeof props.onClosePreview === 'function' ? () => props.onClosePreview() : undefined,
          }, '收起')),
        h('div', { className: 'dr-notes-preview-path' }, String(preview.relPath || '')),
        h('pre', { className: 'dr-notes-preview-text' }, String(preview.markdown || '')))
      : null,
    h('div', { className: 'dr-notes-list' }, items.map((item) => FileRow(item, props))),
    h('div', { className: 'dr-notes-foot' },
      h('div', null,
        '笔记按章分小节：蒸馏要点、我的批注、问过的问题都在对应那一章下面。'),
      summary.pending > 0
        ? h('div', { className: 'dr-notes-pending' }, '还有 ' + summary.pending + ' 块没写进去，点上面的按钮同步。')
        : null,
      summary.conflicted > 0
        ? h('div', { className: 'dr-notes-pending' }, '有 ' + summary.conflicted + ' 块你自己改过，我不会覆盖它们。')
        : null,
      summary.skippedQa > 0
        ? h('div', { className: 'dr-notes-pending' }, '有 ' + summary.skippedQa + ' 条讨论没有章节位置，暂时没写进去。')
        : null),
  )
}

/**
 * 「人物关系」那一段（0.13.0 P5）。
 *
 * 三条规矩，都来自「不能让用户觉得程序在瞎编」：
 *   · 不是小说、也没开始抽 —— 说明理由，不给按钮。硬凑一张图比没有更糟；
 *   · 每一批都要能看见进度 —— 一部长篇要跑好几批，中途看不见就以为卡死了；
 *   · 关系图是 Mermaid 代码块，交给 Obsidian 渲染，这里不自己画。
 */

/** 按钮上该写什么、能不能点。抽完了就不再给「继续抽」，免得用户一直点。 */
export function relationsActionText(state) {
  if (!state || typeof state !== 'object') return { text: '生成人物关系', disabled: true, why: '还没读到状态' }
  const progress = state.progress && typeof state.progress === 'object' ? state.progress : {}
  const total = Number.isFinite(progress.total) ? progress.total : 0
  const done = Number.isFinite(progress.done) ? progress.done : 0
  const failed = Number.isFinite(progress.failed) ? progress.failed : 0
  const verdict = state.verdict && typeof state.verdict === 'object' ? state.verdict : {}

  if (total === 0) {
    if (verdict.fiction === false) {
      return { text: '生成人物关系', disabled: true, why: String(verdict.reason || '这本书看起来不像小说') }
    }
    return { text: '开始抽人物关系', disabled: state.canBuild === false, why: '' }
  }
  if (done + failed >= total) {
    return { text: '已抽完', disabled: true, why: '想重来就点「清空」' }
  }
  return { text: '继续抽下一批（' + (done + failed) + ' / ' + total + '）', disabled: state.canBuild === false, why: '' }
}

/** 关系图的 Mermaid 代码，从宿主给的正文里抠出来。抠不到就不显示图。 */
export function relationsMermaid(markdown) {
  const text = typeof markdown === 'string' ? markdown : ''
  const match = /(?:^|\n)[ ]*```mermaid[ ]*\n([\s\S]*?)```/.exec(text)
  return match ? match[1].trim() : ''
}

/** 这一批抽完的交代：抽到几条、丢掉几条（原句核不上的）。 */
export function relationsNotice(result) {
  if (!result || typeof result !== 'object') return ''
  const batch = result.batch && typeof result.batch === 'object' ? result.batch : null
  if (!batch) return ''
  const kept = Number.isFinite(batch.kept) ? batch.kept : 0
  const dropped = Number.isFinite(batch.dropped) ? batch.dropped : 0
  const where = typeof batch.label === 'string' && batch.label !== '' ? batch.label + '：' : ''
  if (kept === 0) {
    return where + (dropped > 0
      ? '没找到能在原文里核对上的关系（' + dropped + ' 条原句对不上，丢掉了）。'
      : '这一批里没出现新的人物关系。')
  }
  return where + '抽到 ' + kept + ' 条关系' + (dropped > 0 ? '，另有 ' + dropped + ' 条原句核不上，丢掉了' : '') + '。'
}

/**
 * 一条候选主题的一行字（0.13.0 P5 第二半）。
 *
 * 宿主已经算好 line 了，这里只在缺失时兜一句 —— 界面不该因为少一个字段就空着。
 */
export function candidateText(candidate) {
  if (!candidate || typeof candidate !== 'object') return ''
  if (typeof candidate.line === 'string' && candidate.line !== '') return candidate.line
  const books = Number.isFinite(candidate.bookCount) ? candidate.bookCount : 0
  const blocks = Number.isFinite(candidate.blockCount) ? candidate.blockCount : 0
  return '出现在 ' + books + ' 本书、' + blocks + ' 段讨论'
}
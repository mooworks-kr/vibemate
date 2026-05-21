// Sprint 26 (i18n) / T1 — locale state + translation dictionary + persist glue.
//
// Single source of truth for the web client's UI strings. Renderers call
// `t(key)`; mutations call `setLocale(next, render)`; bootstrap calls
// `loadPersistedLocale()` once so the first paint already reflects the
// user's choice.
//
// This module is intentionally tiny and runtime-light — no framework, no
// reactive store. Subscription is a single optional `onChange` callback
// passed to `setLocale`; the caller (main.ts) ties it to `render()`.
//
// Persistence reuses persist.ts so private-mode / quota / SSR failures
// degrade to "ko default for this session" instead of throwing.

import { readPersistedString, writePersistedString } from './persist.js';

export type Locale = 'ko' | 'en';

const STORAGE_KEY = 'vibemate.locale';
const DEFAULT_LOCALE: Locale = 'ko';

/**
 * Translation dictionary. Sample sidebar keys are wired up here to prove
 * the infra round-trips; the bulk of the externalisation arrives in T2.
 *
 * Convention: dotted namespace.key. Missing entries fall back to the
 * caller's `fallback` arg (or the key itself), so a half-finished
 * translation never blanks out the UI.
 *
 * Exported so the T4 dict-completeness assertion can compare ko/en key sets
 * without re-routing through a getter — the most common i18n regression is
 * adding a ko entry and forgetting the en mirror.
 */
export const DICT: Record<Locale, Record<string, string>> = {
  ko: {
    // Tabs (main nav)
    'tab.workspace': '📋 내 작업',
    'tab.overview': '오버뷰',
    'tab.docs': '문서',
    'tab.features': '기능',
    'tab.decisions': '결정 기록',
    'tab.sessions': '세션 로그',

    // Sidebar
    'sidebar.features': '기능',
    'sidebar.group.in_progress': '진행 중',
    'sidebar.group.todo': '할 일',
    'sidebar.group.done': '완료',
    'sidebar.add.feature.placeholder': '새 기능 이름…',
    'sidebar.done.hide': '숨기기',
    'sidebar.done.hide.title': '완료된 기능 숨기기',
    'sidebar.done.show.title': '완료된 기능 보이기',
    'sidebar.done.collapsed': '완료 {count}개 (숨김 · 보이기)',

    // Status labels (Feature + Task)
    'status.todo': '할 일',
    'status.in_progress': '진행 중',
    'status.done': '완료',
    'status.archived': '보관됨',

    // Feature detail — sections
    'feature.section.spec': '스펙',
    'feature.section.tasks': '할 일',
    'feature.section.files': '관련 코드',
    'feature.section.docs': '관련 문서',
    'feature.section.decisions': '관련 결정',
    'feature.section.sessions': '작업 기록',
    'feature.flow.meta': '관련 파일 {files} · 결정 {decisions} · 문서 {docs} · 세션 {sessions}',
    'feature.file.last_edited': '마지막 수정: {time} (총 {count}건)',
    'feature.task.add': '태스크 추가',
    'feature.task.add.placeholder': '새 태스크 이름…',
    'feature.empty.title': '기능을 선택해주세요',
    'feature.empty.text': '왼쪽에서 기능을 클릭하면 상세 정보가 표시됩니다.',
    'feature.list.empty.title': '아직 기능이 없습니다',
    'feature.docs.empty': '연결된 문서가 없습니다. 문서 탭에서 작성한 PRD/기획서를 이 기능에 매핑할 수 있어요.',
    'feature.docs.picker.placeholder': '— 문서 연결 —',
    'feature.docs.picker.submit': '+ 연결',

    // Common buttons / actions
    'button.edit': '수정',
    'button.delete': '삭제',
    'button.cancel': '취소',
    'button.save': '저장',
    'button.unlink.file': '매핑 해제',
    'button.unlink.file.title': '이 기능에서 파일 매핑을 해제',
    'button.unlink.doc': '연결 해제',
    'button.unlink.doc.title': '이 문서와의 연결을 해제',
    'button.task.delete.title': '태스크 삭제',
    'button.task.toggle.done': '완료 해제',
    'button.task.toggle.todo': '완료로 표시',
    'button.copy': '복사',
    'button.edit.feature.name': '이름 수정',
    'button.edit.feature.title': '이름 수정',

    // Project / Overview tab
    'project.empty.select': '프로젝트를 선택해주세요',
    'overview.loading': '오버뷰 불러오는 중…',
    'overview.next_action': '다음 액션',
    'overview.active_features': '활성 기능',
    'overview.all_features': '전체 기능 →',
    'overview.recent_sessions': '최근 세션',
    'overview.all_sessions': '세션 전체 →',
    'overview.recent_decisions': '최근 결정',
    'overview.all_decisions': '결정 전체 →',
    'overview.empty.features': '진행 중이거나 todo 인 기능이 없습니다.',
    'overview.empty.sessions': '아직 세션 기록이 없습니다.',
    'overview.empty.decisions': '아직 결정 기록이 없습니다.',
    'overview.health.active': '진행 중',
    'overview.health.todo_only': '시작 대기',
    'overview.health.stale': '정체',
    'overview.health.empty': '비어 있음',
    'overview.stats.active_features.label': '진행 중인 기능',
    'overview.stats.active_features.trend': '/ {total} 전체',
    'overview.stats.todo_tasks.label': '미완료 태스크',
    'overview.stats.todo_tasks.trend': '{done}개 완료',
    'overview.stats.sessions_this_week.label': '이번 주 세션',
    'overview.stats.decisions.label': '결정 기록',
    'overview.last_activity.recent': '최근 활동 {time}',
    'overview.last_activity.none': '활동 기록 없음',
    'overview.empty.cli.title': '아직 기능이 없습니다',
    'overview.empty.cli.text':
      'CLI 에서 시작하기:'
      + '\n  • `pm import-history` — git history 로 sessions 가져오기'
      + '\n  • `pm extract-features` — commit prefix 로 feature 추출'
      + '\n또는 사이드바에서 기능을 직접 추가하세요.',

    // Docs (Spec Hub)
    'docs.title': '문서 (Spec Hub)',
    'docs.tagline': 'PRD / 기획서 / 아키텍처 노트 / 회고 / feature spec — feature 와 연결해 작업 컨텍스트를 보존합니다.',
    'docs.loading': '문서 불러오는 중…',
    'docs.empty.title': '아직 문서가 없습니다',
    'docs.empty.text': '`+ 문서 추가` 로 PRD / 기획서 / 아키텍처 메모를 등록할 수 있어요. 작성한 문서는 검색(Cmd+K) 에서도 잡힙니다.',
    'docs.detail.notfound': '문서를 찾지 못했습니다',
    'docs.detail.back': '← 문서 목록',
    'docs.detail.updated_prefix': '업데이트 ',
    'docs.detail.recently': '방금',
    'docs.detail.preview': '미리보기',
    'docs.detail.empty.body': '본문이 비어있습니다. "수정" 으로 작성하세요.',
    'docs.form.title': '제목',
    'docs.form.title.placeholder': '문서 제목 (필수)',
    'docs.form.kind': '종류',
    'docs.form.body': 'Markdown 본문',
    'docs.add': '+ 문서 추가',
    'docs.detail.toggle.preview': '미리보기',
    'docs.detail.toggle.edit': '편집',
    'docs.form.body.placeholder': '## 배경\n...\n## 비범위\n...',
    'docs.form.submit.create': '생성',
    'docs.form.submit.update': '저장',
    'docs.field.title': '제목',
    'docs.kind.prd': 'PRD',
    'docs.kind.planning': '기획서',
    'docs.kind.architecture': '아키텍처',
    'docs.kind.retro': '회고',
    'docs.kind.feature_spec': 'Feature Spec',
    'docs.kind.other': '기타',
    'docs.load.failed': '문서 로드 실패',
    'overview.load.failed': '오버뷰 로드 실패',

    // Decisions (ADR)
    'decisions.breadcrumb': '결정 기록',
    'decisions.title': '결정 기록 (ADR)',
    'decisions.tagline': '아키텍처 결정 사항. Claude가 세션 중 의사결정을 감지해 자동 기록하거나, 직접 작성할 수 있습니다.',
    'decisions.add': '+ 결정 기록',
    'decisions.empty.title': '아직 결정 기록이 없습니다',
    'decisions.empty.text': 'Claude 세션 중 의미있는 결정이 감지되면 여기에 자동으로 기록됩니다.',
    'decisions.edit.title': '결정 수정',
    'decisions.delete.title': '결정 삭제',
    'decisions.field.context': '배경',
    'decisions.field.decision': '결정',
    'decisions.field.alternatives': '대안',
    'decisions.feature.linked': '관련 기능 · ',
    'decisions.form.feature.label': '관련 기능 (선택)',
    'decisions.form.feature.none': '— 없음 —',
    'decisions.form.field.title': '제목',
    'decisions.form.submit.create': '저장',
    'decisions.form.submit.update': '수정 저장',
    'decisions.form.field.context': '배경',
    'decisions.form.field.alternatives': '대안',
    'decisions.form.field.decision': '결정',
    'decisions.form.field.consequences': '결과/영향',
    'decisions.form.placeholder.required': '{label} (필수)',

    // Sessions
    'sessions.breadcrumb': '세션 로그',
    'sessions.title': '세션 로그',
    'sessions.tagline': 'Claude Code로 작업한 모든 세션의 기록. 세션 종료 시 요약이 자동 저장됩니다.',
    'sessions.empty.title': '세션 기록이 없습니다',
    'sessions.empty.text': 'Claude Code로 작업을 시작하면 세션이 자동 기록됩니다.',
    'sessions.day.today': '오늘',
    'sessions.day.yesterday': '어제',
    'sessions.day.earlier': '이전',
    'sessions.remaining_prefix': '남은 일: ',

    // Context Brief
    'brief.title': '에이전트 컨텍스트',
    'brief.copy': '복사',
    'brief.copy.title': 'Markdown 을 클립보드에 복사',
    'brief.intro': '새 에이전트 세션에 붙여넣어 프로젝트 + 기능 + 진행 상황을 한 번에 전달합니다.',
    'brief.loading': 'Context Brief 불러오는 중…',
    'brief.toggle.expand': '펼쳐보기',
    'brief.toggle.collapse': '접기',
    'brief.load.failed': 'Context Brief 로드 실패',
    'brief.count.tasks': '작업 {n}',
    'brief.count.files': '파일 {n}',
    'brief.count.docs': '문서 {n}',
    'brief.count.decisions': '결정 {n}',
    'brief.count.sessions': '세션 {n}',

    // Session detail
    'session.detail.loading': '세션 불러오는 중…',
    'session.detail.back': '← 세션 목록',
    'session.detail.feature_prefix': '연결된 기능: ',
    'session.detail.notes': '메모',
    'session.detail.notes.empty': '메모가 없습니다. claudeMdTemplate v4 가이드에 따라 `## 완료 / ## 남은 일 / ## 결정` 형태로 작성하면 다음 세션에서 자동 노출됩니다.',
    'session.detail.files': '수정한 파일',
    'session.detail.no_summary': '(요약 없음)',
    'session.detail.started': '시작 {time}',
    'session.detail.ended': ' · 종료 {time}',
    'session.detail.ongoing': ' · 진행 중',
    'session.detail.load.failed': '세션 로드 실패',
    'session.detail.prev': '← 이전 세션 ({time})',
    'session.detail.next': '다음 세션 ({time}) →',
    'session.detail.no_prev': '이전 세션 없음',
    'session.detail.no_next': '다음 세션 없음',

    // Workspace
    'workspace.breadcrumb': '워크스페이스',
    'workspace.title': '내 작업',
    'workspace.tagline': '등록된 모든 프로젝트의 진행 중인 기능을 한 곳에서.',
    'workspace.filter': '필터:',
    'workspace.error.title': '워크스페이스를 불러오지 못했습니다',
    'workspace.loading': '불러오는 중…',
    'workspace.empty.title': '진행 중인 기능이 없습니다',
    'workspace.overview.title': '프로젝트 오버뷰로 이동',
    'workspace.activity.none': '활동 없음',
    'workspace.empty.text':
      '`pm import-history`로 git history를 sessions로 가져오거나, '
      + '`pm extract-features`로 commit prefix에서 feature를 추출하거나, '
      + '사이드바에서 프로젝트를 선택해 수동으로 기능을 추가하세요.',

    // Project list / global errors
    'project.error.title': '데이터를 불러오지 못했습니다',
    'project.list.loading': '불러오는 중…',
    'project.list.empty.title': '등록된 프로젝트가 없습니다',
    'project.list.empty.text': 'CLI로 프로젝트를 초기화하세요: `pm init --name "<프로젝트>"`',

    // Search palette
    'search.empty.no_project': '프로젝트를 먼저 선택하세요.',
    'search.empty.no_query': '검색어를 입력하세요. (한국어/영문 모두 지원)',
    'search.empty.loading': '검색 중…',
    'search.error': '검색에 실패했습니다: {message}',
    'search.empty.no_results': '검색 결과가 없습니다.',
    'search.error.generic': '검색에 실패했습니다',
    'search.palette.placeholder': '기능, 결정, 세션, 파일 검색…',
    'search.aria.label': '검색',
    'search.kind.feature': '기능',
    'search.kind.decision': '결정',
    'search.kind.document': '문서',
    'search.kind.session': '세션',
    'search.kind.file': '파일',
    'project.switcher.none': '프로젝트 없음',
    'feature.field.name': '이름',
    'feature.status.title': '상태 변경',
    'topbar.search.placeholder': '기능, 파일, 결정 검색…',
    'topbar.claude.btn': 'Claude로 작업',
    'topbar.claude.alert': '실제 데이터 모드에서는 Claude Code 세션을 시작하고 현재 컨텍스트를 자동 주입합니다.',
    'topbar.theme.aria': '테마 전환',
    'topbar.theme.title': '라이트/다크 테마 전환',
    'app.title': 'Vibemate · 바이브 코딩 프로젝트 매니저',

    // Mutation confirms
    'confirm.task.delete': '이 태스크를 삭제할까요?',
    'confirm.document.delete': '이 문서를 삭제할까요?',
    'confirm.unlink.feature_doc': '이 연결을 해제할까요?',

    // Sprint 28 (pax6) — 프로젝트 삭제 모달 (type-to-confirm)
    'project.delete.kebab.title': '프로젝트 옵션',
    'project.delete.menu': '프로젝트 삭제',
    'project.delete.modal.title': '프로젝트 삭제',
    'project.delete.modal.subtitle': '이 작업은 되돌릴 수 없습니다.',
    'project.delete.modal.loading': '영향을 분석 중…',
    'project.delete.modal.impact_heading': '함께 삭제될 항목',
    'project.delete.modal.impact.features': '기능 (features)',
    'project.delete.modal.impact.tasks': '태스크 (tasks)',
    'project.delete.modal.impact.sessions': '세션 (sessions)',
    'project.delete.modal.impact.decisions': '결정 기록 (decisions)',
    'project.delete.modal.impact.documents': '문서 (documents)',
    'project.delete.modal.impact.feature_files': '파일 매핑 (feature_files)',
    'project.delete.modal.impact.document_features': '문서-기능 링크 (document_features)',
    'project.delete.modal.impact.imported_commits': 'import 커밋 (imported_commits)',
    'project.delete.modal.impact.extracted_features': '추출된 기능 (extracted_features)',
    'project.delete.modal.active_warn': '⚠ 활성 세션이 {n}건 진행 중입니다.',
    'project.delete.modal.force_label': '활성 세션을 무시하고 강제 삭제',
    'project.delete.modal.confirm_label': '계속하려면 프로젝트 이름을 정확히 입력하세요: {name}',
    'project.delete.modal.confirm_placeholder': '프로젝트 이름',
    'project.delete.modal.cancel': '취소',
    'project.delete.modal.delete': '삭제',
    'toast.project.deleted': '프로젝트 삭제됨',

    // Toasts
    'toast.task.deleted': '태스크 삭제됨',
    'toast.decision.deleted': '결정 삭제됨',
    'confirm.decision.delete': '이 결정 기록({id})을 삭제할까요?',
    'toast.file.unlinked': '매핑 해제됨',
    'confirm.file.unlink': '이 매핑을 해제할까요?\n{path}',
    'toast.document.added': '문서 추가됨',
    'toast.document.deleted': '문서 삭제됨',
    'toast.document.linked': '연결됨',
    'toast.document.unlinked': '연결 해제됨',
    'toast.brief.copied': 'Context Brief 복사됨',
    'toast.brief.copy.failed': '복사에 실패했습니다.',
    'error.network': '네트워크 오류',
    'error.workspace.load.failed': '워크스페이스 로드 실패',
    'validate.unknown_field': '알 수 없는 필드: {field}',
    'validate.required.with_field': '{field}: 필수 입력',
    'validate.required.label': '{label}: 필수 입력',
    'validate.invalid_enum': '잘못된 값: {raw}',

    // Breadcrumb separator
    'breadcrumb.sep': ' / ',

    // Relative time buckets (relTime helper). Server emits some of these via
    // its own relativeTime() in Korean too — keeping both sides in sync is on
    // the roadmap; for now the client formatter follows the locale.
    'time.just_now': '방금',
    'time.minutes': '{n}분 전',
    'time.hours': '{n}시간 전',
    'time.yesterday': '어제',
    'time.days': '{n}일 전',
    'time.weeks': '{n}주 전',
    'time.months': '{n}달 전',
  },
  en: {
    // Tabs
    'tab.workspace': '📋 My Work',
    'tab.overview': 'Overview',
    'tab.docs': 'Docs',
    'tab.features': 'Features',
    'tab.decisions': 'Decisions',
    'tab.sessions': 'Sessions',

    // Sidebar
    'sidebar.features': 'Features',
    'sidebar.group.in_progress': 'In Progress',
    'sidebar.group.todo': 'To Do',
    'sidebar.group.done': 'Done',
    'sidebar.add.feature.placeholder': 'New feature name…',
    'sidebar.done.hide': 'hide',
    'sidebar.done.hide.title': 'Hide completed features',
    'sidebar.done.show.title': 'Show completed features',
    'sidebar.done.collapsed': '{count} done (hidden · show)',

    // Status labels
    'status.todo': 'To Do',
    'status.in_progress': 'In Progress',
    'status.done': 'Done',
    'status.archived': 'Archived',

    // Feature detail
    'feature.section.spec': 'Spec',
    'feature.section.tasks': 'Tasks',
    'feature.section.files': 'Related Code',
    'feature.section.docs': 'Related Docs',
    'feature.section.decisions': 'Related Decisions',
    'feature.section.sessions': 'Session Log',
    'feature.flow.meta': '{files} files · {decisions} decisions · {docs} docs · {sessions} sessions',
    'feature.file.last_edited': 'Last edited: {time} ({count} total)',
    'feature.task.add': 'Add task',
    'feature.task.add.placeholder': 'New task name…',
    'feature.empty.title': 'Select a feature',
    'feature.empty.text': 'Click a feature on the left to see its details.',
    'feature.list.empty.title': 'No features yet',
    'feature.docs.empty': 'No linked documents. You can map PRDs/specs created in the Docs tab to this feature.',
    'feature.docs.picker.placeholder': '— Link a document —',
    'feature.docs.picker.submit': '+ Link',

    // Common buttons
    'button.edit': 'Edit',
    'button.delete': 'Delete',
    'button.cancel': 'Cancel',
    'button.save': 'Save',
    'button.unlink.file': 'Unlink',
    'button.unlink.file.title': 'Unlink this file from the feature',
    'button.unlink.doc': 'Unlink',
    'button.unlink.doc.title': 'Unlink this document',
    'button.task.delete.title': 'Delete task',
    'button.task.toggle.done': 'Mark not done',
    'button.task.toggle.todo': 'Mark done',
    'button.copy': 'Copy',
    'button.edit.feature.name': 'Edit name',
    'button.edit.feature.title': 'Edit name',

    // Project / Overview
    'project.empty.select': 'Select a project',
    'overview.loading': 'Loading overview…',
    'overview.next_action': 'Next action',
    'overview.active_features': 'Active features',
    'overview.all_features': 'All features →',
    'overview.recent_sessions': 'Recent sessions',
    'overview.all_sessions': 'All sessions →',
    'overview.recent_decisions': 'Recent decisions',
    'overview.all_decisions': 'All decisions →',
    'overview.empty.features': 'No in-progress or todo features.',
    'overview.empty.sessions': 'No sessions yet.',
    'overview.empty.decisions': 'No decisions yet.',
    'overview.health.active': 'Active',
    'overview.health.todo_only': 'Awaiting Start',
    'overview.health.stale': 'Stale',
    'overview.health.empty': 'Empty',
    'overview.stats.active_features.label': 'Active features',
    'overview.stats.active_features.trend': '/ {total} total',
    'overview.stats.todo_tasks.label': 'Open tasks',
    'overview.stats.todo_tasks.trend': '{done} done',
    'overview.stats.sessions_this_week.label': 'Sessions this week',
    'overview.stats.decisions.label': 'Decisions',
    'overview.last_activity.recent': 'Last activity {time}',
    'overview.last_activity.none': 'No activity yet',
    'overview.empty.cli.title': 'No features yet',
    'overview.empty.cli.text':
      'Get started from the CLI:'
      + '\n  • `pm import-history` — import sessions from git history'
      + '\n  • `pm extract-features` — extract features from commit prefixes'
      + '\nOr add features directly in the sidebar.',

    // Docs
    'docs.title': 'Docs (Spec Hub)',
    'docs.tagline': 'PRDs / planning / architecture notes / retros / feature specs — link them to features to preserve working context.',
    'docs.loading': 'Loading documents…',
    'docs.empty.title': 'No documents yet',
    'docs.empty.text': 'Use `+ Add document` to register a PRD / planning memo / architecture note. Documents are also indexed in search (Cmd+K).',
    'docs.detail.notfound': 'Document not found',
    'docs.detail.back': '← Documents',
    'docs.detail.updated_prefix': 'Updated ',
    'docs.detail.recently': 'just now',
    'docs.detail.preview': 'Preview',
    'docs.detail.empty.body': 'Body is empty. Click "Edit" to write one.',
    'docs.form.title': 'Title',
    'docs.form.title.placeholder': 'Document title (required)',
    'docs.form.kind': 'Kind',
    'docs.form.body': 'Markdown body',
    'docs.add': '+ Add document',
    'docs.detail.toggle.preview': 'Preview',
    'docs.detail.toggle.edit': 'Edit',
    'docs.form.body.placeholder': '## Context\n...\n## Non-goals\n...',
    'docs.form.submit.create': 'Create',
    'docs.form.submit.update': 'Save',
    'docs.field.title': 'Title',
    'docs.kind.prd': 'PRD',
    'docs.kind.planning': 'Planning',
    'docs.kind.architecture': 'Architecture',
    'docs.kind.retro': 'Retro',
    'docs.kind.feature_spec': 'Feature Spec',
    'docs.kind.other': 'Other',
    'docs.load.failed': 'Failed to load documents',
    'overview.load.failed': 'Failed to load overview',

    // Decisions
    'decisions.breadcrumb': 'Decisions',
    'decisions.title': 'Decisions (ADR)',
    'decisions.tagline': 'Architecture decisions. Claude logs them automatically during sessions, or you can author them directly.',
    'decisions.add': '+ Log decision',
    'decisions.empty.title': 'No decisions logged',
    'decisions.empty.text': 'Meaningful decisions made during Claude sessions are recorded here automatically.',
    'decisions.edit.title': 'Edit decision',
    'decisions.delete.title': 'Delete decision',
    'decisions.field.context': 'Context',
    'decisions.field.decision': 'Decision',
    'decisions.field.alternatives': 'Alternatives',
    'decisions.feature.linked': 'Related feature · ',
    'decisions.form.feature.label': 'Related feature (optional)',
    'decisions.form.feature.none': '— None —',
    'decisions.form.field.title': 'Title',
    'decisions.form.submit.create': 'Save',
    'decisions.form.submit.update': 'Save changes',
    'decisions.form.field.context': 'Context',
    'decisions.form.field.alternatives': 'Alternatives',
    'decisions.form.field.decision': 'Decision',
    'decisions.form.field.consequences': 'Consequences',
    'decisions.form.placeholder.required': '{label} (required)',

    // Sessions
    'sessions.breadcrumb': 'Sessions',
    'sessions.title': 'Session Log',
    'sessions.tagline': 'A log of every session you ran with Claude Code. A summary is saved automatically when each session ends.',
    'sessions.empty.title': 'No session logs',
    'sessions.empty.text': 'Start a session with Claude Code and it will appear here automatically.',
    'sessions.day.today': 'Today',
    'sessions.day.yesterday': 'Yesterday',
    'sessions.day.earlier': 'Earlier',
    'sessions.remaining_prefix': 'Remaining: ',

    // Context Brief
    'brief.title': 'Agent context',
    'brief.copy': 'Copy',
    'brief.copy.title': 'Copy Markdown to clipboard',
    'brief.intro': 'Paste into a fresh agent session to hand off project + feature + progress in one go.',
    'brief.loading': 'Loading Context Brief…',
    'brief.toggle.expand': 'Expand',
    'brief.toggle.collapse': 'Collapse',
    'brief.load.failed': 'Failed to load Context Brief',
    'brief.count.tasks': '{n} tasks',
    'brief.count.files': '{n} files',
    'brief.count.docs': '{n} docs',
    'brief.count.decisions': '{n} decisions',
    'brief.count.sessions': '{n} sessions',

    // Session detail
    'session.detail.loading': 'Loading session…',
    'session.detail.back': '← Sessions',
    'session.detail.feature_prefix': 'Linked feature: ',
    'session.detail.notes': 'Notes',
    'session.detail.notes.empty': 'No notes. Follow the claudeMdTemplate v4 guide and write `## Done / ## Remaining / ## Decisions` to have them surface in the next session automatically.',
    'session.detail.files': 'Modified files',
    'session.detail.no_summary': '(no summary)',
    'session.detail.started': 'Started {time}',
    'session.detail.ended': ' · Ended {time}',
    'session.detail.ongoing': ' · Active',
    'session.detail.load.failed': 'Failed to load session',
    'session.detail.prev': '← Previous session ({time})',
    'session.detail.next': 'Next session ({time}) →',
    'session.detail.no_prev': 'No previous session',
    'session.detail.no_next': 'No next session',

    // Workspace
    'workspace.breadcrumb': 'Workspace',
    'workspace.title': 'My Work',
    'workspace.tagline': 'All in-progress features across every registered project, in one place.',
    'workspace.filter': 'Filter:',
    'workspace.error.title': 'Failed to load workspace',
    'workspace.loading': 'Loading…',
    'workspace.empty.title': 'No active features',
    'workspace.overview.title': 'Go to project overview',
    'workspace.activity.none': 'No activity',
    'workspace.empty.text':
      'Use `pm import-history` to pull git history into sessions, '
      + '`pm extract-features` to derive features from commit prefixes, '
      + 'or pick a project in the sidebar and add features manually.',

    // Project list / global errors
    'project.error.title': 'Failed to load data',
    'project.list.loading': 'Loading…',
    'project.list.empty.title': 'No projects registered',
    'project.list.empty.text': 'Initialise a project from the CLI: `pm init --name "<project>"`',

    // Search palette
    'search.empty.no_project': 'Select a project first.',
    'search.empty.no_query': 'Type to search. (Both Korean and English work.)',
    'search.empty.loading': 'Searching…',
    'search.error': 'Search failed: {message}',
    'search.empty.no_results': 'No results.',
    'search.error.generic': 'Search failed',
    'search.palette.placeholder': 'Search features, decisions, sessions, files…',
    'search.aria.label': 'Search',
    'search.kind.feature': 'Features',
    'search.kind.decision': 'Decisions',
    'search.kind.document': 'Docs',
    'search.kind.session': 'Sessions',
    'search.kind.file': 'Files',
    'project.switcher.none': 'No project',
    'feature.field.name': 'Name',
    'feature.status.title': 'Change status',
    'topbar.search.placeholder': 'Search features, files, decisions…',
    'topbar.claude.btn': 'Work with Claude',
    'topbar.claude.alert': 'In live mode this would open a Claude Code session and pre-load the current context.',
    'topbar.theme.aria': 'Toggle theme',
    'topbar.theme.title': 'Switch light/dark theme',
    'app.title': 'Vibemate · Vibe Coding Project Manager',

    // Mutation confirms
    'confirm.task.delete': 'Delete this task?',
    'confirm.document.delete': 'Delete this document?',
    'confirm.unlink.feature_doc': 'Unlink this connection?',

    // Sprint 28 (pax6) — project delete modal (type-to-confirm)
    'project.delete.kebab.title': 'Project options',
    'project.delete.menu': 'Delete project',
    'project.delete.modal.title': 'Delete project',
    'project.delete.modal.subtitle': 'This action cannot be undone.',
    'project.delete.modal.loading': 'Analyzing impact…',
    'project.delete.modal.impact_heading': 'Will also be deleted',
    'project.delete.modal.impact.features': 'Features',
    'project.delete.modal.impact.tasks': 'Tasks',
    'project.delete.modal.impact.sessions': 'Sessions',
    'project.delete.modal.impact.decisions': 'Decisions',
    'project.delete.modal.impact.documents': 'Documents',
    'project.delete.modal.impact.feature_files': 'File mappings (feature_files)',
    'project.delete.modal.impact.document_features': 'Doc-feature links (document_features)',
    'project.delete.modal.impact.imported_commits': 'Imported commits (imported_commits)',
    'project.delete.modal.impact.extracted_features': 'Extracted features (extracted_features)',
    'project.delete.modal.active_warn': '⚠ {n} active session(s) in progress.',
    'project.delete.modal.force_label': 'Force delete (ignore active sessions)',
    'project.delete.modal.confirm_label': 'To continue, type the project name exactly: {name}',
    'project.delete.modal.confirm_placeholder': 'Project name',
    'project.delete.modal.cancel': 'Cancel',
    'project.delete.modal.delete': 'Delete',
    'toast.project.deleted': 'Project deleted',

    // Toasts
    'toast.task.deleted': 'Task deleted',
    'toast.decision.deleted': 'Decision deleted',
    'confirm.decision.delete': 'Delete decision {id}?',
    'toast.file.unlinked': 'File unlinked',
    'confirm.file.unlink': 'Unlink this mapping?\n{path}',
    'toast.document.added': 'Document added',
    'toast.document.deleted': 'Document deleted',
    'toast.document.linked': 'Linked',
    'toast.document.unlinked': 'Unlinked',
    'toast.brief.copied': 'Context Brief copied',
    'toast.brief.copy.failed': 'Copy failed.',
    'error.network': 'Network error',
    'error.workspace.load.failed': 'Failed to load workspace',
    'validate.unknown_field': 'Unknown field: {field}',
    'validate.required.with_field': '{field}: required',
    'validate.required.label': '{label}: required',
    'validate.invalid_enum': 'Invalid value: {raw}',

    // Breadcrumb separator (kept identical so dynamic project/feature names
    // join naturally on both sides).
    'breadcrumb.sep': ' / ',

    // Relative time buckets
    'time.just_now': 'just now',
    'time.minutes': '{n}m ago',
    'time.hours': '{n}h ago',
    'time.yesterday': 'yesterday',
    'time.days': '{n}d ago',
    'time.weeks': '{n}w ago',
    'time.months': '{n}mo ago',
  },
};

let currentLocale: Locale = DEFAULT_LOCALE;

/** Whitelist guard for values coming out of localStorage / user input. */
function isLocale(v: unknown): v is Locale {
  return v === 'ko' || v === 'en';
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Update the active locale. Persists immediately (best-effort via persist.ts)
 * and fires `onChange` so the caller can re-render. No-op when `loc` matches
 * the current locale — avoids spurious re-renders on toggle UIs that just
 * mirror the existing value.
 */
export function setLocale(loc: Locale, onChange?: () => void): void {
  if (loc === currentLocale) return;
  currentLocale = loc;
  writePersistedString(STORAGE_KEY, loc);
  onChange?.();
}

/** Values accepted by the placeholder-interpolation form of `t()`. */
export type TVars = Record<string, string | number>;

/**
 * Look up `key` in the active locale's dictionary.
 *
 * Second arg is either:
 *   - `string` → fallback used when the key is missing
 *   - `object` → placeholder vars; `{name}` in the template is replaced with
 *     `String(vars.name)`. The fallback path collapses to the key itself.
 *
 * Never returns undefined, so call sites don't have to defend against
 * missing entries. Always-resolved templates also keep the build's
 * `strictNullChecks` happy for chained string ops.
 *
 * Examples:
 *   t('button.save')                          → "저장"
 *   t('button.unknown', 'Save')               → "Save"
 *   t('flow.meta', { files: 3, decisions: 1, docs: 2, sessions: 0 })
 *                                             → "관련 파일 3 · 결정 1 · 문서 2 · 세션 0"
 */
export function t(key: string, fallbackOrVars?: string | TVars): string {
  const hit = DICT[currentLocale][key];

  // String form: pure fallback. Used when a key may not exist yet during
  // incremental externalisation (T2 is staged).
  if (typeof fallbackOrVars === 'string') {
    return hit ?? fallbackOrVars;
  }

  // Object form (or no arg): resolve the template, then interpolate vars
  // when present. Missing keys default to the key string itself so the UI
  // still surfaces *something* identifiable instead of empty space.
  let template = hit ?? key;
  if (fallbackOrVars && typeof fallbackOrVars === 'object') {
    for (const [k, v] of Object.entries(fallbackOrVars)) {
      template = template.split(`{${k}}`).join(String(v));
    }
  }
  return template;
}

/**
 * Bootstrap-time hook. Reads the persisted locale (default `ko`) and
 * installs it as the active one. Safe to call once before the first
 * `render()` so the initial paint already reflects the user's choice;
 * subsequent calls are still safe but redundant.
 */
export function loadPersistedLocale(): void {
  const raw = readPersistedString(STORAGE_KEY, null);
  currentLocale = isLocale(raw) ? raw : DEFAULT_LOCALE;
}

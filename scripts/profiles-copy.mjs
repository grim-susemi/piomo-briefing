// Identity-only F6 migration from todo 12's naming-map.json. Captions,
// task steps, region comparisons and picker widths retain their contracts.
export const RAW_NAME_COPY = {
  '전역 적용 중': 'current',
  '적용 중': 'current',
  '공통 설정 · Kibitzer 회상': 'shared-memory · Kibitzer',
  '공통 설정 · Reflection 성찰': 'shared-memory · Reflection',
  '전담 에이전트 · Agents': 'Agents',
  '탐색 · 자료 조사': 'discovery',
  '계획 · 조언': 'planning',
  '검토 · QA': 'review',
  '작업 카테고리 · Categories': 'Categories',
  '빠른 작업 · 일반 작업': 'general',
  '심층 추론': 'reasoning',
  '전문 작업': 'specialism',
  '공통 / 전체 · Kibitzer 회상': 'shared-memory · Kibitzer',
  '공통 / 전체 · Reflection 성찰': 'shared-memory · Reflection',
};

export const RAW_CONDITIONAL_NAME_COPY = { '추가 설정': 'extras' };

export const RAW_STATUS_COPY = {
  '현재: ': 'current: ',
  '보류: ': 'pending: ',
  '저장됨 · 다음 대화부터 반영': 'saved · 다음 대화부터 반영',
  '실패 · 보류 유지: ': 'failure · pending retained: ',
  ' · 변경 보류 1건': ' · pending 1',
};

export const reportBlocks = () => [
  { kind: 'table', title: '표', columns: ['항목', '값'], rows: [['문자', 12]] },
  { kind: 'bars', title: '막대', unit: '개', items: [{ label: '완료', value: 0 }] },
  { kind: 'kv', title: '항목', items: [{ key: '상태', value: '진행' }] },
  { kind: 'flow', title: '흐름', steps: [{ label: '시작', state: 'done' }, { label: '다음' }] },
  { kind: 'checklist', title: '확인', items: [{ id: 'check-1', text: '확인할 것' }] },
  { kind: 'compare', title: '비교', decisionIndex: 0, rows: [{ label: '비용', A: '낮음', B: '높음', C: '중간' }] },
];

export const decisionFields = () => [
  { id: 'name', label: '작업 이름', kind: 'text', maxLen: 200 },
  { id: 'side_width', label: '사이드바 너비', kind: 'number', min: 200, max: 400, step: 20 },
  { id: 'theme', label: '화면 테마', kind: 'choice', options: ['시스템 따라감', '밝게', '어둡게'] },
  { id: 'layout', label: '배치', kind: 'choice', options: ['기본', '넓게', '좁게', '자동'] },
];
export const decisionValues = () => ({ name: '보드', side_width: 280, theme: '밝게', layout: '자동' });

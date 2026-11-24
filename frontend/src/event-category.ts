export const eventCategories = [
  { value: 'uncategorized', label: 'Без категории' },
  { value: 'navigation', label: 'Навигация' },
  { value: 'interaction', label: 'Взаимодействие' },
];

export function categoryLabel(value?: string) {
  return eventCategories.find(category => category.value === value)?.label ?? eventCategories[0].label;
}

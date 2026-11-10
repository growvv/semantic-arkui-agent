export class TaskItem {
  id: string;
  title: string;
  project: string;
  dueDate: string;
  priority: string;
  completed: boolean;
  favorite: boolean;

  constructor(
    id: string,
    title: string,
    project: string,
    dueDate: string,
    priority: string,
    completed: boolean,
    favorite: boolean
  ) {
    this.id = id;
    this.title = title;
    this.project = project;
    this.dueDate = dueDate;
    this.priority = priority;
    this.completed = completed;
    this.favorite = favorite;
  }
}

export function seedTasks(): TaskItem[] {
  return [
    new TaskItem('t1', '整理季度材料', '北区门店', '2026-10-15', '普通', false, false),
    new TaskItem('t2', '整理季度材料', '线上商城', '2026-10-20', '普通', false, false),
    new TaskItem('t3', '更新采购台账', '北区门店', '2026-10-18', '低', false, true),
    new TaskItem('t4', '核对活动预算', '线上商城', '2026-10-22', '高', true, false),
    new TaskItem('t5', '预订客户出差', '市场', '2026-11-03', '普通', false, false)
  ];
}

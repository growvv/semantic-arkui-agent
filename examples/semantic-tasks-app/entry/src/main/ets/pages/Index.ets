import { Sem } from '../semantics/Sem';
import { TaskItem, seedTasks } from '../model/TaskItem';
import { EvalLog } from '../eval/EvalLog';

@Entry
@Component
struct Index {
  @State tasks: TaskItem[] = seedTasks();
  @State query: string = '';
  @State onlyOpen: boolean = false;
  @State onlyFavorite: boolean = false;
  @State detailOpen: boolean = false;
  @State selectedId: string = '';
  @State editDueDate: string = '';

  aboutToAppear(): void {
    this.logState();
  }

  private logState(): void {
    EvalLog.state(this.tasks, this.query, this.onlyOpen, this.onlyFavorite, this.selectedId);
  }

  private visibleTasks(): TaskItem[] {
    const keyword = this.query.trim();
    return this.tasks.filter((task: TaskItem) => {
      if (this.onlyOpen && task.completed) {
        return false;
      }
      if (this.onlyFavorite && !task.favorite) {
        return false;
      }
      if (keyword.length > 0 && !task.title.includes(keyword) && !task.project.includes(keyword)) {
        return false;
      }
      return true;
    });
  }

  private selectedTask(): TaskItem | undefined {
    return this.tasks.find((task: TaskItem) => task.id === this.selectedId);
  }

  private selectedTitle(): string {
    const task = this.selectedTask();
    return task === undefined ? '' : task.title;
  }

  private selectedDue(): string {
    const task = this.selectedTask();
    return task === undefined ? '' : task.dueDate;
  }

  private replaceTask(updated: TaskItem): void {
    this.tasks = this.tasks.map((item: TaskItem) => item.id === updated.id ? updated : item);
  }

  private toggleFavorite(task: TaskItem): void {
    this.replaceTask(new TaskItem(
      task.id, task.title, task.project, task.dueDate, task.priority, task.completed, !task.favorite
    ));
    this.logState();
  }

  private toggleCompleted(task: TaskItem): void {
    this.replaceTask(new TaskItem(
      task.id, task.title, task.project, task.dueDate, task.priority, !task.completed, task.favorite
    ));
    this.logState();
  }

  private cyclePriority(task: TaskItem): void {
    const order: string[] = ['低', '普通', '高'];
    const index = order.indexOf(task.priority);
    const next = order[(index + 1) % order.length];
    this.replaceTask(new TaskItem(
      task.id, task.title, task.project, task.dueDate, next === undefined ? '普通' : next,
      task.completed, task.favorite
    ));
    this.logState();
  }

  private openDetail(task: TaskItem): void {
    this.selectedId = task.id;
    this.editDueDate = '';
    this.detailOpen = true;
    this.logState();
  }

  private closeDetail(): void {
    this.detailOpen = false;
    this.editDueDate = '';
    this.logState();
  }

  private saveDueDate(): void {
    const task = this.selectedTask();
    if (task === undefined) {
      return;
    }
    const value = this.editDueDate.trim();
    if (value.length === 0) {
      return;
    }
    this.replaceTask(new TaskItem(
      task.id, task.title, task.project, value, task.priority, task.completed, task.favorite
    ));
    this.detailOpen = false;
    this.editDueDate = '';
    this.logState();
  }

  private clearFilters(): void {
    this.query = '';
    this.onlyOpen = false;
    this.onlyFavorite = false;
    this.logState();
  }

  @Builder
  taskRow(task: TaskItem) {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Text(task.title)
          .id(`sem.task.title.${task.id}`)
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
          .accessibilityText(`任务：${task.title}；项目：${task.project}；到期：${task.dueDate}；优先级：${task.priority}；状态：${task.completed ? '已完成' : '进行中'}`)
          .customProperty('sem', Sem.safe(() => Sem.node({
            schema: 1,
            id: `sem.task.title.${task.id}`,
            role: 'content',
            meaning: `任务：${task.title}；项目：${task.project}；到期：${task.dueDate}；优先级：${task.priority}；状态：${task.completed ? '已完成' : '进行中'}；收藏：${task.favorite ? '是' : '否'}`,
            entityKind: 'task',
            entityKey: task.id,
            state: {
              completed: task.completed,
              favorite: task.favorite,
              priority: task.priority
            },
            actions: []
          }), Sem.fallback(`sem.task.title.${task.id}`)))
        Button(task.favorite ? '★' : '☆')
          .id(`sem.task.favorite.${task.id}`)
          .fontSize(20)
          .backgroundColor('#00000000')
          .fontColor(task.favorite ? '#E6A700' : '#888888')
          .accessibilityText(`${task.favorite ? '取消收藏' : '收藏'}：${task.title}`)
          .customProperty('sem', Sem.safe(() => Sem.node({
            schema: 1,
            id: `sem.task.favorite.${task.id}`,
            role: 'action',
            meaning: `${task.favorite ? '取消收藏' : '收藏'}：${task.title}（项目：${task.project}，到期：${task.dueDate}）`,
            entityKind: 'task',
            entityKey: task.id,
            state: {
              favorite: task.favorite,
              completed: task.completed
            },
            actions: [{
              name: 'toggle_favorite',
              input: 'tap',
              label: task.favorite ? '取消收藏' : '收藏'
            }],
            risk: 'changes_data'
          }), Sem.fallback(`sem.task.favorite.${task.id}`)))
          .onClick(() => this.toggleFavorite(task))
      }
      .width('100%')

      Row({ space: 8 }) {
        Text(`${task.project} · 到期 ${task.dueDate} · 优先级 ${task.priority}`)
          .fontSize(13)
          .fontColor('#666666')
          .layoutWeight(1)
      }
      .width('100%')

      Row({ space: 8 }) {
        Button(task.completed ? '重新打开' : '标记完成')
          .id(`sem.task.complete.${task.id}`)
          .fontSize(13)
          .accessibilityText(`${task.completed ? '重新打开' : '标记完成'}：${task.title}`)
          .customProperty('sem', Sem.safe(() => Sem.node({
            schema: 1,
            id: `sem.task.complete.${task.id}`,
            role: 'action',
            meaning: `${task.completed ? '重新打开' : '标记完成'}：${task.title}（项目：${task.project}）`,
            entityKind: 'task',
            entityKey: task.id,
            state: {
              completed: task.completed
            },
            actions: [{
              name: 'toggle_completion',
              input: 'tap',
              label: task.completed ? '重新打开' : '标记完成'
            }],
            risk: 'changes_data'
          }), Sem.fallback(`sem.task.complete.${task.id}`)))
          .onClick(() => this.toggleCompleted(task))
        Button('调整优先级')
          .id(`sem.task.priority.${task.id}`)
          .fontSize(13)
          .accessibilityText(`调整优先级：${task.title}，当前${task.priority}`)
          .customProperty('sem', Sem.safe(() => Sem.node({
            schema: 1,
            id: `sem.task.priority.${task.id}`,
            role: 'action',
            meaning: `调整优先级：${task.title}（当前${task.priority}）`,
            entityKind: 'task',
            entityKey: task.id,
            state: {
              priority: task.priority
            },
            actions: [{
              name: 'cycle_priority',
              input: 'tap',
              label: '按低、普通、高循环调整'
            }],
            constraints: '每次点击按 低→普通→高→低 循环',
            risk: 'changes_data'
          }), Sem.fallback(`sem.task.priority.${task.id}`)))
          .onClick(() => this.cyclePriority(task))
        Button('编辑截止日期')
          .id(`sem.task.detail.${task.id}`)
          .fontSize(13)
          .accessibilityText(`编辑截止日期：${task.title}，当前${task.dueDate}`)
          .customProperty('sem', Sem.safe(() => Sem.node({
            schema: 1,
            id: `sem.task.detail.${task.id}`,
            role: 'action',
            meaning: `编辑截止日期：${task.title}（当前${task.dueDate}）`,
            entityKind: 'task',
            entityKey: task.id,
            state: {
              value: task.dueDate
            },
            actions: [{
              name: 'open_due_date_editor',
              input: 'tap',
              label: '打开截止日期编辑'
            }],
            risk: 'changes_data'
          }), Sem.fallback(`sem.task.detail.${task.id}`)))
          .onClick(() => this.openDetail(task))
      }
      .width('100%')
    }
    .width('100%')
    .padding(12)
    .backgroundColor('#FFFFFF')
    .borderRadius(10)
  }

  @Builder
  filterRow() {
    Row({ space: 8 }) {
      Text('只看未完成')
        .fontSize(13)
      Toggle({ type: ToggleType.Switch, isOn: this.onlyOpen })
        .id('sem.filter.open')
        .accessibilityText(`只看未完成：${this.onlyOpen ? '开' : '关'}`)
        .customProperty('sem', Sem.node({
          schema: 1,
          id: 'sem.filter.open',
          role: 'toggle',
          meaning: `只看未完成（当前${this.onlyOpen ? '开' : '关'}）`,
          state: {
            selected: this.onlyOpen
          },
          actions: [{
            name: 'toggle_open_filter',
            input: 'tap',
            label: '切换只看未完成'
          }],
          risk: 'read_only'
        }))
        .onChange((isOn: boolean) => {
          this.onlyOpen = isOn;
          this.logState();
        })
      Text('只看收藏')
        .fontSize(13)
      Toggle({ type: ToggleType.Switch, isOn: this.onlyFavorite })
        .id('sem.filter.favorite')
        .accessibilityText(`只看收藏：${this.onlyFavorite ? '开' : '关'}`)
        .customProperty('sem', Sem.node({
          schema: 1,
          id: 'sem.filter.favorite',
          role: 'toggle',
          meaning: `只看收藏（当前${this.onlyFavorite ? '开' : '关'}）`,
          state: {
            selected: this.onlyFavorite
          },
          actions: [{
            name: 'toggle_favorite_filter',
            input: 'tap',
            label: '切换只看收藏'
          }],
          risk: 'read_only'
        }))
        .onChange((isOn: boolean) => {
          this.onlyFavorite = isOn;
          this.logState();
        })
      Button('清除筛选')
        .id('sem.filter.clear')
        .fontSize(12)
        .accessibilityText('清除搜索和筛选')
        .customProperty('sem', Sem.node({
          schema: 1,
          id: 'sem.filter.clear',
          role: 'action',
          meaning: '清除搜索和筛选',
          state: {
            value: this.query
          },
          actions: [{
            name: 'clear_filters',
            input: 'tap',
            label: '清除搜索和筛选'
          }],
          risk: 'read_only'
        }))
        .onClick(() => this.clearFilters())
    }
    .width('100%')
  }

  @Builder
  detailPanel() {
    Column({ space: 10 }) {
      Text('编辑截止日期')
        .fontSize(18)
        .fontWeight(FontWeight.Bold)
        .width('100%')
      Text(`任务：${this.selectedTitle()}；当前截止日期：${this.selectedDue()}`)
        .fontSize(13)
        .fontColor('#666666')
        .width('100%')
      TextInput({ placeholder: 'YYYY-MM-DD', text: this.editDueDate })
        .id('sem.detail.due')
        .height(44)
        .accessibilityText(`截止日期输入框：${this.selectedTitle()}，当前${this.selectedDue()}`)
        .customProperty('sem', Sem.node({
          schema: 1,
          id: 'sem.detail.due',
          role: 'input',
          meaning: `截止日期输入框：${this.selectedTitle()}（当前${this.selectedDue()}）`,
          state: {
            value: this.editDueDate
          },
          actions: [{
            name: 'set_due_date',
            input: 'set_text',
            label: '输入新的截止日期'
          }],
          constraints: '格式 YYYY-MM-DD',
          risk: 'changes_data'
        }))
        .onChange((value: string) => {
          this.editDueDate = value;
          this.logState();
        })
      Row({ space: 10 }) {
        Button('保存')
          .id('sem.detail.save')
          .accessibilityText(`保存截止日期：${this.selectedTitle()}`)
          .customProperty('sem', Sem.node({
            schema: 1,
            id: 'sem.detail.save',
            role: 'action',
            meaning: `保存截止日期：${this.selectedTitle()}（新值：${this.editDueDate}）`,
            state: {
              value: this.editDueDate
            },
            actions: [{
              name: 'save_due_date',
              input: 'tap',
              label: '保存新的截止日期'
            }],
            risk: 'changes_data'
          }))
          .onClick(() => this.saveDueDate())
        Button('取消')
          .id('sem.detail.cancel')
          .accessibilityText('取消编辑截止日期')
          .customProperty('sem', Sem.node({
            schema: 1,
            id: 'sem.detail.cancel',
            role: 'action',
            meaning: '取消编辑截止日期',
            actions: [{
              name: 'cancel_due_date',
              input: 'tap',
              label: '取消编辑'
            }],
            risk: 'read_only'
          }))
          .onClick(() => this.closeDetail())
      }
      .width('100%')
    }
    .width('90%')
    .padding(16)
    .backgroundColor('#FFFFFF')
    .borderRadius(12)
    .margin({ bottom: 24 })
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column({ space: 10 }) {
        Text('Tasks')
          .fontSize(26)
          .fontWeight(FontWeight.Bold)
          .width('100%')
        Text('任务、筛选、收藏与截止日期')
          .fontSize(13)
          .fontColor('#666666')
          .width('100%')

        TextInput({ placeholder: '搜索任务或项目', text: this.query })
          .id('sem.search')
          .height(44)
          .accessibilityText(`搜索任务或项目，当前：${this.query}`)
          .customProperty('sem', Sem.node({
            schema: 1,
            id: 'sem.search',
            role: 'input',
            meaning: `搜索任务或项目（当前：${this.query}）`,
            state: {
              value: this.query
            },
            actions: [{
              name: 'set_query',
              input: 'set_text',
              label: '输入搜索词'
            }],
            constraints: '匹配任务标题或项目名',
            risk: 'read_only'
          }))
          .onChange((value: string) => {
            this.query = value;
            this.logState();
          })

        this.filterRow()

        List({ space: 10 }) {
          ForEach(this.visibleTasks(), (task: TaskItem) => {
            ListItem() {
              this.taskRow(task)
            }
          }, (task: TaskItem) => `${task.id}:${task.completed}:${task.favorite}:${task.priority}:${task.dueDate}`)
        }
        .id('sem.task.list')
        .layoutWeight(1)
        .width('100%')
        .customProperty('sem', Sem.node({
          schema: 1,
          id: 'sem.task.list',
          role: 'list',
          meaning: `任务列表（当前显示 ${this.visibleTasks().length} 项）`,
          state: {
            value: this.visibleTasks().length
          },
          actions: [{
            name: 'scroll_tasks',
            input: 'scroll',
            label: '滚动任务列表',
            directions: ['forward', 'backward']
          }],
          risk: 'read_only'
        }))
      }
      .width('100%')
      .height('100%')
      .padding(16)
      .backgroundColor('#F2F3F5')

      if (this.detailOpen) {
        this.detailPanel()
      }
    }
    .id('sem.root')
    .width('100%')
    .height('100%')
  }
}

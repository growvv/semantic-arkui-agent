import { hilog } from '@kit.PerformanceAnalysisKit';
import { TaskItem } from '../model/TaskItem';

export interface EvalPayload {
  tasks: TaskItem[];
  query: string;
  onlyOpen: boolean;
  onlyFavorite: boolean;
  selectedId: string;
}

export class EvalLog {
  static state(
    tasks: TaskItem[],
    query: string,
    onlyOpen: boolean,
    onlyFavorite: boolean,
    selectedId: string
  ): void {
    const payload: EvalPayload = {
      tasks: tasks,
      query: query,
      onlyOpen: onlyOpen,
      onlyFavorite: onlyFavorite,
      selectedId: selectedId
    };
    hilog.info(0x0000, 'SEM_EVAL', '%{public}s', JSON.stringify(payload));
  }
}

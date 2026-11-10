@Entry
@Component
struct Sample {
  @State query: string = '';
  @State value: number = 25;

  build() {
    Column() {
      Text('收藏').onClick(() => {})
      Button('搜索').onClick(() => {})
      TextInput({ placeholder: '搜索任务', text: this.query })
      Slider({ min: 1, max: 100, value: this.value })
      Image($r('app.media.star')).onClick(() => {})
    }
    .width('100%')
  }
}

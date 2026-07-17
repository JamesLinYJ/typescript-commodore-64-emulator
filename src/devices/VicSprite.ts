export class VicSprite {
  x = 0;
  y = 0;
  enabled = false;
  foreground = true;
  multicolor = false;
  expandVertical = false;
  expandHorizontal = false;
  collisionWithSprite = false;
  collisionWithForeground = false;

  constructor(public color: number) {}

  reset(color: number): void {
    this.x = 0;
    this.y = 0;
    this.enabled = false;
    this.foreground = true;
    this.multicolor = false;
    this.expandVertical = false;
    this.expandHorizontal = false;
    this.collisionWithSprite = false;
    this.collisionWithForeground = false;
    this.color = color;
  }
}

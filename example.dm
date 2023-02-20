type Pos = {
	x:i32,
	y:i32,
	z:i32
}

fn make-pos()
	let my = Pos { x: 5, y: 4, z: 3 }
	let my2 = Pos { x: 11, y: 20, z: 33 }
	let my3 =
		let hello = Pos { x: 11, y: 2, z: 3 }
		hello
	my3

fn main()
	let a = make-pos()
	a.x

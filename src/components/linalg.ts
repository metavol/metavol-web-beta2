// linear algebra library
// Kenji Hirata
// 2024/4/28

export const solve = (left:number[][], right:number[]) => {
    const A00 = left[0][0];
    const A01 = left[0][1];
    const A02 = left[0][2];
    const A03 = right[0];

    const A10 = left[1][0];
    const A11 = left[1][1];
    const A12 = left[1][2];
    const A13 = right[1];

    const A20 = left[2][0];
    const A21 = left[2][1];
    const A22 = left[2][2];
    const A23 = right[2];

    const x = (A01*A12*A23 - A01*A13*A22 - A02*A11*A23 + A02*A13*A21 + A03*A11*A22 - A03*A12*A21)/(A00*A11*A22 - A00*A12*A21 - A01*A10*A22 + A01*A12*A20 + A02*A10*A21 - A02*A11*A20);
    const y = (-A00*A12*A23 + A00*A13*A22 + A02*A10*A23 - A02*A13*A20 - A03*A10*A22 + A03*A12*A20)/(A00*A11*A22 - A00*A12*A21 - A01*A10*A22 + A01*A12*A20 + A02*A10*A21 - A02*A11*A20);
    const z = (A00*A11*A23 - A00*A13*A21 - A01*A10*A23 + A01*A13*A20 + A03*A10*A21 - A03*A11*A20)/(A00*A11*A22 - A00*A12*A21 - A01*A10*A22 + A01*A12*A20 + A02*A10*A21 - A02*A11*A20);

    return [x,y,z];
}


// tests 

// {
// const L = [[5, -4, 6], [7, -6, 10],[4, 9, 7]];
// const R = [8,14,74];
// const Ans = solve(L,R);
// console.log(Ans);
// }
// [ 2, 5, 3 ]


// {
// const L = [[5, -4, 6], [5, 3, 6],[4, 9, 7]];
// const R = [8,9,74];
// const Ans = solve(L,R);
// console.log(Ans);
// }

// [ -34.20779220779221, 0.14285714285714285, 29.935064935064936 ]



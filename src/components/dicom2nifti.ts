// retiring 2024/6/9

import { DataSet } from "dicom-parser";
import * as THREE from 'three';

interface MyDataSet extends DataSet {
    decompressed: ArrayBuffer;
  }

export const save = (buffer: ArrayBuffer) => {
    const a = document.createElement("a");
    document.body.appendChild(a);
    // a.style = "display: none";
    // console.log(a);

    //ArrayBufferをBlobに変換                                                                                                                                                
    var blob = new Blob([buffer], {type: "octet/stream"}),
    url = window.URL.createObjectURL(blob);
    // console.log(url);

    //データを保存する                                                                                                                                                     
    a.href = url;
    a.download = "aaa";
    a.click();
    window.URL.revokeObjectURL(url);
}

export const generateNiftiFromDicom = (dcmList: MyDataSet[]) => {

    const suvFactor = getSuvFactor(dcmList) ?? 1;

    const d = dcmList[0];
    const d1 = dcmList[1];

    const nx = d.int16("x00280011")!; // columns
    const ny = d.int16("x00280010")!; // rows
    const nz = dcmList.length;

    const vx = new THREE.Vector3(
        d.floatString("x00200037",0)!, // 	Image Orientation (Patient)
        d.floatString("x00200037",1)!,
        d.floatString("x00200037",2)!
    );
    const px = d.floatString("x00280030",0)!; // pixel spacing
    vx.multiplyScalar(px / vx.length());
    vx.multiplyScalar(-1);

    const vy = new THREE.Vector3(
        d.floatString("x00200037",3)!, // 	Image Orientation (Patient)
        d.floatString("x00200037",4)!,
        d.floatString("x00200037",5)!
    );
    const py = d.floatString("x00280030",1)!; // pixel spacing
    vy.multiplyScalar(py / vy.length());
    vy.multiplyScalar(-1);

    // slice locationは、たまに、image positionのz座標と符号が反対のことがある。
    // そのため、下記の式は使えない。
    // const sl = d.floatString("x00201041")!; // slice location
    // const sl1 = d1.floatString("x00201041")!; // slice location

    const pos0 = new THREE.Vector3(
        d.floatString("x00200032",0)!, //	Image Position (Patient)
        d.floatString("x00200032",1)!,
        d.floatString("x00200032",2)!
    );

    const pos1 = new THREE.Vector3(
        d1.floatString("x00200032",0)!,
        d1.floatString("x00200032",1)!,
        d1.floatString("x00200032",2)!
    );

    const vz = pos1.clone();
    vz.sub(pos0);
    const pz = vz.length();

    // const center = [0,0,0];

    let buffer = new ArrayBuffer(352 + nx*ny*nz*4);
    let dv = new DataView(buffer);
    dv.setInt32(0x00, 348, true); // 15c
    dv.setInt16(0x28, 3, true); // dim[0]
    dv.setInt16(0x2a, nx, true); // dim[1]
    dv.setInt16(0x2c, ny, true); // dim[2]
    dv.setInt16(0x2e, nz, true); // dim[3]
    dv.setInt16(0x30, 1, true); // dim[4]
    dv.setInt16(0x32, 1, true); // dim[5]
    dv.setInt16(0x34, 1, true); // dim[6]
    dv.setInt16(0x36, 1, true); // dim[7]
    dv.setInt16(0x46, 0x10, true); // datatype 0x10=float
    dv.setInt16(0x48, 0x20, true); // bitpix (32)
    dv.setFloat32(0x4c, 1, true); // pixdim[0] = 1
    dv.setFloat32(0x50, px, true); // pixdim[1]
    dv.setFloat32(0x54, py, true); // pixdim[2]
    dv.setFloat32(0x58, Math.abs(pz), true); // pixdim[3]
    dv.setFloat32(0x5c, 1, true); // pixdim[4]
    dv.setFloat32(0x60, 1, true); // pixdim[5]
    dv.setFloat32(0x64, 1, true); // pixdim[6]
    dv.setFloat32(0x68, 1, true); // pixdim[7]
    dv.setFloat32(0x6c, 352, true); // vox_offset
    dv.setFloat32(0x70, 1, true); // scl_slope
    dv.setFloat32(0x74, 0, true); // scl_inter

    dv.setInt16(0xfc, 0, true); // qform_code
    dv.setInt16(0xfe, 1, true); // sform_code
    
    // x = srow_x[0] * i + srow_x[1] * j + srow_x[2] * k + srow_x[3]
    // y = srow_y[0] * i + srow_y[1] * j + srow_y[2] * k + srow_y[3]
    // z = srow_z[0] * i + srow_z[1] * j + srow_z[2] * k + srow_z[3]

    dv.setFloat32(0x118, vx.x, true); // srow_x[0]
    dv.setFloat32(0x11c, vx.y, true); // srow_x[1]
    dv.setFloat32(0x120, vx.z, true); // srow_x[2]
    dv.setFloat32(0x124, pos0.x, true); // srow_x[3]

    dv.setFloat32(0x128, vy.x, true); // srow_y[0]
    dv.setFloat32(0x12c, vy.y, true); // srow_y[1]
    dv.setFloat32(0x130, vy.z, true); // srow_y[2]
    dv.setFloat32(0x134, pos0.y, true); // srow_y[3]

    dv.setFloat32(0x138, vz.x, true); // srow_z[0]
    dv.setFloat32(0x13c, vz.y, true); // srow_z[1]
    dv.setFloat32(0x140, vz.z, true); // srow_z[2]
    dv.setFloat32(0x144, pos0.z, true); // srow_z[3]
    
    dv.setUint8(0x158, 0x6e); // n
    dv.setUint8(0x159, 0x2b); // +
    dv.setUint8(0x15a, 0x31); // 1
    dv.setUint8(0x15b, 0x00); // \0


    let ad = 352;
    for (let i = 0; i<nz; i++){
        const dataSet = dcmList[i];
        const pixelDataElement = dataSet.elements.x7fe00010;
        const intercept = Number(dataSet.string("x00281052") ?? "0");
        const slope = Number(dataSet.string("x00281053") ?? "1");
        const aaa = new Int16Array(
            dataSet.byteArray.buffer,
            pixelDataElement.dataOffset,
            pixelDataElement.length / 2
          );
        

        for (let j = 0; j<ny; j++){
            for (let k = 0; k<nx; k++){
                const v = (aaa[j*nx+k] * slope + intercept)*suvFactor;
                dv.setFloat32(ad, v, true);
                ad+=4;
            }
        }
    }

    return buffer;
}



export const generateDemoNii = () => {

    const nx = 100;
    const ny = 100;
    const nz = 140;
    const px = 0.75;
    const py = 0.75;
    const pz = 2;
    const center = [0,0,0];


    let buffer = new ArrayBuffer(352 + nx*ny*nz*4);
    let dv = new DataView(buffer);
    dv.setInt32(0x00, 348, true); // 15c
    dv.setInt16(0x28, 3, true); // dim[0]
    dv.setInt16(0x2a, nx, true); // dim[1]
    dv.setInt16(0x2c, ny, true); // dim[2]
    dv.setInt16(0x2e, nz, true); // dim[3]
    dv.setInt16(0x30, 1, true); // dim[4]
    dv.setInt16(0x32, 1, true); // dim[5]
    dv.setInt16(0x34, 1, true); // dim[6]
    dv.setInt16(0x36, 1, true); // dim[7]
    dv.setInt16(0x46, 0x10, true); // datatype 0x10=float
    dv.setInt16(0x48, 0x20, true); // bitpix (32)
    dv.setFloat32(0x4c, 1, true); // pixdim[0] = 1
    dv.setFloat32(0x50, px, true); // pixdim[1]
    dv.setFloat32(0x54, py, true); // pixdim[2]
    dv.setFloat32(0x58, pz, true); // pixdim[3]
    dv.setFloat32(0x5c, 1, true); // pixdim[4]
    dv.setFloat32(0x60, 1, true); // pixdim[5]
    dv.setFloat32(0x64, 1, true); // pixdim[6]
    dv.setFloat32(0x68, 1, true); // pixdim[7]
    dv.setFloat32(0x6c, 352, true); // vox_offset
    dv.setFloat32(0x70, 1, true); // scl_slope
    dv.setFloat32(0x74, 0, true); // scl_inter

    dv.setInt16(0xfc, 0, true); // qform_code
    dv.setInt16(0xfe, 1, true); // sform_code
    
    // x = srow_x[0] * i + srow_x[1] * j + srow_x[2] * k + srow_x[3]
    // y = srow_y[0] * i + srow_y[1] * j + srow_y[2] * k + srow_y[3]
    // z = srow_z[0] * i + srow_z[1] * j + srow_z[2] * k + srow_z[3]

    dv.setFloat32(0x118, px, true); // srow_x[0]
    dv.setFloat32(0x124, center[0], true); // srow_x[3]
    dv.setFloat32(0x12c, py, true); // srow_y[1]
    dv.setFloat32(0x138, center[0], true); // srow_y[3]
    dv.setFloat32(0x140, pz, true); // srow_z[2]
    dv.setFloat32(0x14c, center[0], true); // srow_z[3]
    
    dv.setUint8(0x158, 0x6e); // n
    dv.setUint8(0x159, 0x2b); // +
    dv.setUint8(0x15a, 0x31); // 1
    dv.setUint8(0x15b, 0x00); // \0


    let ad = 352;
    for (let i = 0; i<nz; i++){
        for (let j = 0; j<ny; j++){
            for (let k = 0; k<nx; k++){
                const r2 = (i-nz/2)*(i-nz/2)/10000+(j-ny/2)*(j-ny/2)/10000+(k-nx/2)*(k-nx/2)/10000+0.00001;
                const v = 1/r2 + 10;

                dv.setFloat32(ad, v, true);
                ad+=4;
            }
        }
    }
    return buffer;
}


// public static (double suvFactor, string suvFormula) GetSuvFactor(IEnumerable<DicomFile> dd)
// {
//     DicomFile d = dd.First();

//     double constant = 1;
//     string text = "";

//     var unit = d.GetUnits();
//     var bw = d.GetPatientWeight();
//     var pf = d.GetPhilipsSuvFactor();

//     if ((unit.ToLower() == "bq/cc" || unit.ToLower() == "bqml") && GetCorrectedDosage(dd) != 0 && bw != 0) // TODO 20200607 GetCorrectedDosage(dd)が2度呼ばれて効率悪い。
//     {
//         constant = 1.0 / GetBqmlPerSuv(dd);
//         text = "SUV=[radioactivity_concentration]*[body_weight]/[decay_corrected_dosage]";
//     }
//     else if (unit == "CNTS" && !double.IsNaN(pf))
//     {
//         constant = pf;
//         text = "SUV=CNTS*PhilipsSUVfactor";
//     }

//     return (constant, text);
// }

// public static double GetBqmlPerSuv(IEnumerable<DicomFile> dd)
// {
//     DicomFile d = dd.First();

//     return GetCorrectedDosage(dd) / (d.GetPatientWeight() * 1000);
// }

// public static double GetCorrectedDosage(IEnumerable<DicomFile> dd)
// {
//     DicomFile d = dd.First();

//     var hl = d.GetNest(DicomTag.RadiopharmaceuticalInformationSequence, DicomTag.RadionuclideHalfLife);
//     if (hl == null) hl = "1e+20";

//     var dosage = d.GetRadionuclideTotalDoseDouble();
//     var dc = d.GetDecayCorrection();
//     if (dc.StartsWith("ADMIN")) //注射時刻を基準にPET画像BQMLが与えられるので、SUV計算に試用する注射量は、そのままの値（注射時刻のBq量）を使用。
//     {
//         // do nothing
//     }
//     else if (dc.StartsWith("START")) //スキャン開始時刻を基準にPET画像BQMLが与えられるため、SUV計算に使用する注射量をスキャン開始時刻に補正する。これを指定してくるのは、DICOMファイルだけである。ECATファイルは何も指定してこないが、START相当である。従ってデフォルトではSTARTにしてある。
//     {
//         var halflife = double.Parse(hl, CUL);

//         // TODO 2020/6/7 ealiest acquisition time をscan start timeとして採用する。別法としてseries timeを使用する方法もある。

//         var scanstarttime = dd.Min(d0 => ParseSecond6digits(d0.GetAcquisitionTime()));
//         //var scanstarttime_old_version = ParseSecond6digits(d.GetAcquisitionTime());

//         var dosestarttime = ParseSecond6digits(d.GetRadiopharmaceuticalStartTime());
//         dosage *= Math.Pow(0.5, (scanstarttime - dosestarttime) / halflife);
//     }
//     else
//     {
//         throw new Exception("Neither START nor ADMIN in (0054,1102)");
//     }
//     return dosage;
// }

let log:string[] = [];

const getSuvFactor = (dd: MyDataSet[]) => {

    log = [];

    const d = dd[0];
    let constant = 1;
    // let text = "";
    const unit = d.string("x00541001");
    log.push("unit: "+unit);
    const bw = d.floatString("x00101030");
    log.push("bw: " + bw);
    const pf = d.floatString("x70531000");
    log.push("philips factor: " + pf);

    if ((unit!.toLowerCase() == "bq/cc" || unit?.toLowerCase() == "bqml")
        && getCorrectedDosage(dd) != 0 && bw != 0){
            constant = 1.0 / getBqmlPerSuv(dd, bw!);
            log.push("constant "+constant);
    }else if (unit == "CNTS" && pf != null){
        constant = Number(pf);
    }

    console.log(log);

    return constant;
}

const parseSecond6digits = (str:string) => {
    const h = Number(str.substring(0,2));
    const m = Number(str.substring(2,4));
    const s = Number(str.substring(4,6));
    return h*3600+m*60+s;
}

const getCorrectedDosage = (dd: MyDataSet[]) => {
    const d = dd[0];

    let hl = d.floatString("x00181075"); // half life
    if (hl == null){
        hl = d.elements.x00540016.items![0].dataSet!.floatString("x00181075") // ネスト
    }
    log.push("half life "+hl);

    const dc = d.string("x00541102"); // decay correction
    let dosage = d.floatString("x00181074"); // radionuclide total dose
    if (dosage == null){
        dosage = d.elements.x00540016.items![0].dataSet!.floatString("x00181074") // ネスト
    }
    log.push("dosage (uncorrected) "+dosage);

    if (dc!.startsWith("START")){

        //2024/5/13 本来はすべてのDICOMファイルのscanstarttimeを調べてearliestのものを採択すべきである
        const scanstarttime_ = d.string("x00080032");
        log.push("scanstarttime "+scanstarttime_);
        const scanstarttime = parseSecond6digits(scanstarttime_!); // acuisition time

        let dosestarttime_ = d.string("x00181072"); // Radiopharmaceutical Start Time
        if (dosestarttime_ == null){
            dosestarttime_ = d.elements.x00540016.items![0].dataSet!.string("x00181072") // ネスト
        }
        log.push("dosestarttime "+dosestarttime_);
        const dosestarttime = parseSecond6digits(dosestarttime_!)

        dosage! *= Math.pow(0.5, (scanstarttime - dosestarttime) / hl!);
        log.push("dosage (corrected) "+dosage);
    }
    return dosage!;
};

const getBqmlPerSuv = (dd: MyDataSet[], bw:number) => {
    return getCorrectedDosage(dd) / (bw * 1000);
};



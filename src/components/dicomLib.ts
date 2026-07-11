import { DataSet } from "dicom-parser";

export const allDicomTagToString = (dataSet: DataSet) => {
    let text = "";
    for (const propertyName in dataSet.elements){
        const content = dataSet.string(propertyName);
        const element = dataSet.elements[propertyName];
        text += `${propertyName} ${content} ${element.vr}\r\n`;
      }
    return text;
  }

  
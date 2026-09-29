import { projectedReturnAvailability, rankTransportTargets } from '../dist/src/transport-model.js';
import { formatAssignmentSelection } from '../dist/src/assignment-summary.js';

function updateCargoSummary(picker,direction){
  const selected=[...picker.querySelector('.transport-cargo-options').children].flatMap(label=>{
    const [checkbox,,amount]=label.children;
    return checkbox.checked&&amount.value?[{name:checkbox.dataset.cargoName,amount:amount.value}]:[];
  });
  const formatted=formatAssignmentSelection(selected,direction==='out'?'Cargo':'Cargo back');
  const summary=picker.querySelector('summary');
  summary.textContent=formatted.summary;
  summary.title=formatted.title;
}

function renderCargoPicker(row,direction,available,selected,onChanged){
  const picker=row.querySelector(`[data-cargo-direction="${direction}"]`);
  const host=picker.querySelector('.transport-cargo-options');
  host.replaceChildren();
  for(const item of available){
    const saved=selected.find(value=>value.cargoId===item.cargoId);
    const label=document.createElement('label');
    const checkbox=document.createElement('input');
    checkbox.type='checkbox'; checkbox.dataset.cargoId=String(item.cargoId); checkbox.dataset.cargoName=item.name; checkbox.checked=!!saved;
    const name=document.createElement('span'); name.textContent=`${item.name} · available ${item.availableRaw}`;
    const amount=document.createElement('input');
    amount.type='number'; amount.min='1'; amount.step='1'; amount.value=saved?.amountRaw??''; amount.placeholder='Amount'; amount.disabled=!checkbox.checked; amount.max=item.availableRaw; amount.title=item.title??'';
    checkbox.addEventListener('change',()=>{amount.disabled=!checkbox.checked;if(!checkbox.checked)amount.value='';updateCargoSummary(picker,direction);onChanged();});
    amount.addEventListener('input',()=>{updateCargoSummary(picker,direction);onChanged();});
    label.append(checkbox,name,amount); host.append(label);
  }
  updateCargoSummary(picker,direction);
}

function selectedCargo(row,direction,validAmountsOnly=false){
  const host=row.querySelector(`[data-cargo-direction="${direction}"]`).querySelector('.transport-cargo-options');
  return [...host.children].flatMap(label=>{
    const [checkbox,,amount]=label.children;
    if(!checkbox.checked || (validAmountsOnly&&!/^[1-9]\d*$/.test(amount.value)))return[];
    return[{cargoId:Number(checkbox.dataset.cargoId),amountRaw:amount.value}];
  });
}

export function refreshTransportEditor({row,draft,preferredDestination,catalog,replaceSelectOptions,onChanged}){
  const fleet=catalog.fleets.find(value=>value.address===draft.fleetAddress);
  const home=catalog.transportSystems?.find(value=>value.address===draft.homeSystemAddress);
  const targets=home&&fleet?rankTransportTargets({home,systems:catalog.transportSystems,fleet:fleet.travel,travelMode:draft.travelMode}):[];
  const targetSelect=row.querySelector('[data-field="destination"]');
  replaceSelectOptions(targetSelect,targets.map(value=>({value:value.address,label:`${value.name} · ${value.distance.toFixed(2)}`})),preferredDestination);
  const target=targets.find(value=>value.address===targetSelect.value);
  const outbound=row.initialCargoOut??draft.cargoOut??[];
  const outAvailable=(home?.cargo??[]).filter(item=>BigInt(item.amountRaw)>0n).map(item=>({...item,availableRaw:item.amountRaw}));
  const names=new Map([...(target?.cargo??[]),...(home?.cargo??[])].map(item=>[item.cargoId,item]));
  let backSelected=row.initialCargoBack??draft.cargoBack??[];
  const refreshBack=()=>{
    const backHost=row.querySelector('[data-cargo-direction="back"]').querySelector('.transport-cargo-options');
    if(backHost.children.length)backSelected=selectedCargo(row,'back');
    const projected=projectedReturnAvailability(target?.cargo??[],selectedCargo(row,'out',true));
    const backAvailable=projected.filter(item=>BigInt(item.projectedRaw)>0n).map(item=>({...(names.get(item.cargoId)??{cargoId:item.cargoId,name:`Cargo ${item.cargoId}`}),availableRaw:item.projectedRaw,title:`Live target ${item.liveRaw}; projected after outbound delivery ${item.projectedRaw}`}));
    renderCargoPicker(row,'back',backAvailable,backSelected,onChanged);
  };
  renderCargoPicker(row,'out',outAvailable,outbound,()=>{refreshBack();onChanged();});
  refreshBack();
  delete row.initialCargoOut; delete row.initialCargoBack;
  const crewOut=row.querySelector('[data-field="crew-out"]'),crewBack=row.querySelector('[data-field="crew-back"]');
  crewOut.max=String(Math.min(home?.availableCrew??0,fleet?.passengerCapacity??0)); crewOut.title=`Available at Home: ${home?.availableCrew??0}; passenger capacity: ${fleet?.passengerCapacity??0}`;
  crewBack.max=String(Math.min((target?.availableCrew??0)+(Number(crewOut.value)||0),fleet?.passengerCapacity??0)); crewBack.title=`Available at Target after delivery: ${(target?.availableCrew??0)+(Number(crewOut.value)||0)}; passenger capacity: ${fleet?.passengerCapacity??0}`;
}
